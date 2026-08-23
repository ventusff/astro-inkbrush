/**
 * Static snapshot builder for the share module.
 *
 * A share is a self-contained copy of one built page: a WIKI-free
 * `astro build` into `.wiki/share-dist` (cached across shares while every
 * build input's mtime is older than the cached build's start stamp), then
 * the route's index.html plus its complete asset closure (CSS → url() refs,
 * JS → import graph + emitted `/_astro/…` asset strings) copied into a temp
 * dir. A required asset reference (script src, stylesheet link, image
 * src/srcset, font url()) that resolves inside the site must exist in the
 * build output, or the snapshot fails naming the reference; navigational
 * hrefs stay permissive (page links are not assets). The HTML
 * is re-based from root-relative to `./`-relative (the page lands at
 * /s/<id>/index.html; assets keep their site-root-relative structure), and
 * copied stylesheets likewise. The output is asserted free of CMS and Vite
 * dev strings.
 *
 * Build inputs tracked by the cache: src/, public/, packages/, vendor/, the
 * astro config, package.json and the lockfiles. Environment variables that
 * change a build are not tracked — a deployment that builds differently by
 * env removes `.wiki/share-dist` when the env changes.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { POLLUTION_MARKERS } from '../../lib/pollution-markers.ts';
import { childEnv } from './child-env.ts';
import { containedPath } from './paths.ts';

export interface Snapshot {
  /** temp dir with index.html at its root — caller tars + removes it */
  dir: string;
  /** asset closure copied alongside index.html (outDir-relative paths) */
  files: string[];
}

type Progress = (message: string) => void;

/* ---------------- cached WIKI-free build ---------------- */

/** build outputs and caches — changes there say nothing about the inputs */
const MTIME_SKIP = new Set(['node_modules', '.git', '.astro', '.wiki', 'dist']);

/** latest mtime (ms) across a tree — cheap freshness probe for the cache.
 *  Symlinks are not followed, and each real directory is visited once, so
 *  the walk cannot loop or wander outside the inputs. */
function latestMtime(path: string, visited: Set<string> = new Set()): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0; // missing input (or a raced deletion) — nothing to compare against
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  try {
    const real = realpathSync(path);
    if (visited.has(real)) return 0;
    visited.add(real);
  } catch {
    return 0;
  }
  let latest = stat.mtimeMs;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    if (MTIME_SKIP.has(entry.name)) continue;
    latest = Math.max(latest, latestMtime(join(path, entry.name), visited));
  }
  return latest;
}

/** everything whose change makes a cached build stale: a share is a copy of
 *  the built site, so templates, styles, integrations and config count as
 *  much as content */
function buildInputs(root: string): string[] {
  return [
    join(root, 'src'),
    join(root, 'public'),
    join(root, 'packages'),
    join(root, 'vendor'),
    ...['ts', 'mts', 'js', 'mjs', 'cjs'].map((ext) => join(root, `astro.config.${ext}`)),
    join(root, 'package.json'),
    join(root, 'package-lock.json'),
    join(root, 'pnpm-lock.yaml'),
    join(root, 'yarn.lock'),
  ];
}

/** hard ceiling on one astro build; beyond it the child is terminated */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_KILL_GRACE_MS = 5000;

function runAstroBuild(
  root: string,
  outDirRel: string,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('snapshot build canceled — the client disconnected'));
      return;
    }
    // the project's own astro binary — never a network-resolving npx
    const astroBin = join(root, 'node_modules', '.bin', 'astro');
    if (!existsSync(astroBin)) {
      rejectPromise(new Error(`astro binary not found (${astroBin}) — install the site's dependencies`));
      return;
    }
    // allowlisted environment (WIKI/WIKI_* and server secrets excluded):
    // the integration + rehype plugin are added conditionally by the site's
    // astro.config, so an env without WIKI yields the pure-static page
    const env = childEnv({ prefixes: ['NODE_', 'ASTRO_', 'PUBLIC_'] });
    const child = spawn(astroBin, ['build', '--outDir', outDirRel], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const eat = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    // heartbeat keeps the NDJSON stream alive during a minutes-long cold build
    const started = Date.now();
    const heartbeat = setInterval(() => {
      onProgress(`astro build running… ${Math.round((Date.now() - started) / 1000)}s`);
    }, 10_000);
    // timeout / cancellation: SIGTERM, then SIGKILL after a grace window
    let killReason: string | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const killChild = (reason: string): void => {
      if (killReason) return;
      killReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), BUILD_KILL_GRACE_MS);
    };
    const timeout = setTimeout(() => {
      killChild(`astro build timed out (${BUILD_TIMEOUT_MS / 60000} min) and was terminated`);
    }, BUILD_TIMEOUT_MS);
    const onAbort = (): void => {
      killChild('snapshot build canceled — the client disconnected');
    };
    signal?.addEventListener('abort', onAbort);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      cleanup();
      rejectPromise(new Error(`failed to start astro build: ${err.message}`));
    });
    child.on('close', (code) => {
      cleanup();
      if (killReason) rejectPromise(new Error(killReason));
      else if (code === 0) resolvePromise();
      else rejectPromise(new Error(`astro build failed (code ${code})${tail ? `: …${tail.slice(-600)}` : ''}`));
    });
  });
}

// serialize builds — two concurrent share creations must not race one outDir
let buildChain: Promise<void> = Promise.resolve();

async function ensureBuild(root: string, onProgress: Progress, signal?: AbortSignal): Promise<string> {
  const outDir = join(root, '.wiki', 'share-dist');
  const stampFile = join(root, '.wiki', 'share-dist.stamp');
  // the cache predicate, shared by the freshness check and the post-build
  // drift check: a build whose start stamp is newer than every input's
  // mtime reflects those inputs
  const inputsOlderThan = (stamp: number): boolean =>
    buildInputs(root).every((input) => stamp > latestMtime(input));
  const run = async (): Promise<void> => {
    const stamp = existsSync(stampFile) ? Number(readFileSync(stampFile, 'utf8').trim()) : 0;
    const fresh =
      existsSync(join(outDir, 'index.html')) && Number.isFinite(stamp) && inputsOlderThan(stamp);
    if (fresh) {
      onProgress('Using cached static build');
      return;
    }
    // the stamp records the build's start: an input edited while the build
    // runs is newer than the stamp, so the drift check below catches it and
    // rebuilds once; a second drift fails the share rather than serving a
    // build that mixes pre- and post-edit inputs
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      onProgress(
        attempt === 1
          ? 'Building the static site (WIKI-free astro build) — may take a few minutes on first share…'
          : 'The build inputs changed during the build — rebuilding once…',
      );
      const startedAt = Date.now();
      await runAstroBuild(root, '.wiki/share-dist', onProgress, signal);
      if (inputsOlderThan(startedAt)) {
        writeFileSync(stampFile, String(startedAt));
        onProgress('Static build finished');
        return;
      }
      if (attempt >= 2) {
        throw new Error('the site keeps changing while the snapshot builds — retry when edits pause');
      }
    }
  };
  const chained = buildChain.then(run, run);
  buildChain = chained.catch(() => undefined);
  await chained;
  return outDir;
}

/* ---------------- reference scanning ---------------- */

/** url(...) + @import refs out of a CSS body — same traversal the rewriter uses,
 *  so a stylesheet ref can never be copied without being re-based, or vice versa */
function collectCssUrls(css: string): string[] {
  const refs: string[] = [];
  mapCssRefs(css, (ref) => {
    refs.push(ref);
    return ref;
  });
  return refs;
}

/** static/dynamic import specifiers + Vite-emitted `_astro/…` asset strings.
 *  Vite/esbuild may emit ANY quote style incl. backticks (interpolation-free
 *  template literals), and `__vite__mapDeps` lists chunk deps as
 *  site-root-relative strings WITHOUT the leading slash — cover all of them. */
function collectJsRefs(js: string): string[] {
  const out: string[] = [];
  const push = (spec: string | undefined): void => {
    if (spec && !spec.includes('${')) out.push(spec);
  };
  // import|export … from "…"  (minified `import{a}from"./x.js"` included)
  for (const m of js.matchAll(/\b(?:import|export)\b[^'"`()]*?from\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g)) {
    push(m[1] ?? m[2] ?? m[3]);
  }
  // side-effect `import"./x.js"` and dynamic `import(`./x.js`)`
  for (const m of js.matchAll(/\bimport\s*\(?\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*\)?/g)) {
    push(m[1] ?? m[2] ?? m[3]);
  }
  // emitted assets referenced as plain strings (demo chunks via __vite__mapDeps,
  // textures, images, workers…)— with or without the leading slash
  for (const m of js.matchAll(/["'`](\/?_astro\/[^"'`]+)["'`]/g)) {
    const ref = m[1]!;
    push(ref.startsWith('/') ? ref : `/${ref}`);
  }
  return out;
}

/**
 * a candidate ref → absolute file path inside outDir, or null to skip
 * (external URLs, protocol-relative, path escapes). Existence is checked by
 * the caller — refs to other PAGES resolve to directories and are dropped.
 */
function resolveRef(ref: string, fromDir: string, outDir: string): string | null {
  if (!ref) return null;
  const clean = ref.split('#')[0]!.split('?')[0]!;
  if (!clean) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  let abs: string;
  try {
    abs = clean.startsWith('/')
      ? join(outDir, decodeURIComponent(clean))
      : resolve(fromDir, decodeURIComponent(clean));
  } catch {
    return null;
  }
  if (abs !== outDir && !abs.startsWith(outDir + sep)) return null;
  return abs;
}

// the shared CMS markers plus what only a dev-server leak can carry; the
// exempted site-owned `inkbrush-note` meta tags are stripped before the scan
const POLLUTION = [...POLLUTION_MARKERS, '/api/wiki', '@vite/client', 'astro-dev-toolbar'];
const EXEMPT_TAG = /<meta\s[^>]*name=["']inkbrush-note(?:-url)?["'][^>]*>/gi;

/**
 * One start tag beginning at `at`, or null if `at` is not one.
 *
 * `>` inside a quoted attribute value does not end the tag — `<div data-x="a > b">`
 * is a single tag — so the scan tracks quoting rather than searching for `>`.
 */
function readStartTag(html: string, at: number): { raw: string; name: string; end: number } | null {
  if (!/^<[a-zA-Z]/.test(html.slice(at, at + 2))) return null;
  let i = at + 1;
  let quote: '"' | "'" | null = null;
  while (i < html.length) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') break;
    i += 1;
  }
  const end = i < html.length ? i + 1 : html.length;
  const raw = html.slice(at, end);
  return { raw, name: /^<([a-zA-Z][^\s/>]*)/.exec(raw)?.[1]?.toLowerCase() ?? '', end };
}

/**
 * Markup that can actually execute or fetch: every start tag plus the body of
 * every script. Prose is dropped.
 *
 * The hygiene check exists to catch a CMS-enabled build leaking into a public
 * share, and a leak always arrives as a tag, a script or a stylesheet —
 * never as body text.
 * A plain substring search over the whole document cannot tell the two apart:
 * a note that merely documents an endpoint (`/api/wiki/...` in a table of
 * SAML settings) must still be shareable.
 */
export function executableMarkup(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    const tag = readStartTag(html, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }
    out += `${tag.raw}\n`;
    i = tag.end;
    if (tag.name === 'script' || tag.name === 'style') {
      const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
      const stop = close === -1 ? html.length : close;
      out += `${html.slice(i, stop)}\n`;
      i = stop;
    }
  }
  return out;
}

function assertClean(content: string, what: string): void {
  for (const marker of POLLUTION) {
    if (content.includes(marker)) {
      throw new Error(`snapshot hygiene violation: '${marker}' found in ${what} — WIKI-free build expected`);
    }
  }
}

/* ---------------- URL rewriting ---------------- */

/**
 * Re-base ONE url-ish value so it still resolves once the page lives at
 * `/s/<id>/index.html`.
 *
 * The snapshot keeps the site's directory layout — an asset built at
 * `/wiki/<note>/fig.jpg` is copied to `wiki/<note>/fig.jpg` inside the share —
 * while the page itself moves to the share root. The two reference styles the
 * build emits therefore re-base differently:
 *
 *   `/_astro/app.css`   root-relative  → `./_astro/app.css`
 *   `fig.jpg`           page-relative  → `./<pageDir>/fig.jpg`
 *   `../other/a.png`    page-relative  → `./<normalized>/a.png`
 *   `https://…`, `//cdn/…`, `#anchor`, `?q=1`, `data:…`, `mailto:…` → untouched
 *
 * Page-relative refs are what co-located note attachments use
 * (`<img src="fig.jpg">` beside `index.mdx`); left un-rebased they 404 under
 * `/s/<id>/` even though the bytes are in the tarball.
 *
 * `pageDir` is the built page's directory relative to the site root
 * (`notes/en/getting-started`; empty for a root-level page). Query and
 * fragment ride along untouched, and so do the path's own characters: the
 * gateway maps request paths to files literally, so percent-encoding a name
 * here would turn a working attachment into a 404.
 *
 * A `../` chain that climbs past the site root is clamped at the root, which is
 * what a browser does with the same URL. Returning it unchanged instead would
 * hand the reader a link that escapes `/s/<id>/` entirely.
 */
/**
 * Normalize a site-root-relative path the way a browser would, then clamp it.
 *
 * Three things a plain `posix.normalize` misses, each of which lets a ref climb
 * out of `/s/<id>/` at request time:
 *   - a browser treats `\` as a path separator in http(s) URLs;
 *   - `%2e` / `%2E` is a dot segment during URL path normalization (and the
 *     gateway percent-decodes before touching the disk, so the two agree);
 *   - `../` past the root resolves AT the root rather than above it.
 *
 * Shared by the page rewriter and the stylesheet rewriter so the two can never
 * disagree about what "inside the share" means.
 */
function normalizeSitePath(path: string): string {
  const browserish = path.replaceAll('\\', '/').replace(/%2e/gi, '.');
  return posix
    .normalize(browserish)
    .replace(/^(?:\.\.\/)+/, '')
    .replace(/^\.\.$/, '')
    .replace(/^\.$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function rewriteRef(value: string, pageDir: string): string {
  if (!value.trim()) return value;
  // scheme (http:, data:, mailto:), protocol-relative, fragment-only, query-only
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(value)) return value;

  const split = value.search(/[#?]/);
  const path = split === -1 ? value : value.slice(0, split);
  const suffix = split === -1 ? '' : value.slice(split);
  if (!path) return value;

  const fromRoot = path.startsWith('/') || path.startsWith('\\') ? path.slice(1) : posix.join(pageDir, path);
  // compare and rebuild without the trailing slash, then put it back once
  const normalized = normalizeSitePath(fromRoot).replace(/\/+$/, '');
  // the page being shared now lives at the share root, so its own URL — the
  // language switch, the breadcrumb tail — has to point there rather than at a
  // copy of itself that the snapshot does not contain
  if (normalized === pageDir || normalized === posix.join(pageDir, 'index.html')) {
    return `./${suffix}`;
  }
  const trailing = normalized && path.endsWith('/') ? '/' : '';
  return `./${normalized}${trailing}${suffix}`;
}

/**
 * Map every candidate URL of a `srcset` / `imagesrcset`, descriptors intact.
 *
 * Follows the HTML srcset grammar rather than splitting on commas: a URL may
 * contain commas (a `data:` URL almost always does), so candidates are cut at
 * whitespace first and only then at the comma that ends a descriptor.
 */
function mapSrcset(value: string, map: (ref: string) => string): string {
  const candidates: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i]!)) i++;
    if (i >= value.length) break;
    const urlStart = i;
    while (i < value.length && !/\s/.test(value[i]!)) i++;
    let url = value.slice(urlStart, i);
    // a URL ending in commas is a candidate without a descriptor
    const hadTrailingComma = url.endsWith(',');
    url = url.replace(/,+$/, '');
    let descriptor = '';
    if (!hadTrailingComma) {
      const descStart = i;
      while (i < value.length && value[i] !== ',') i++;
      descriptor = value.slice(descStart, i).trim();
      if (value[i] === ',') i++;
    }
    if (url) candidates.push(descriptor ? `${map(url)} ${descriptor}` : map(url));
  }
  return candidates.join(', ');
}

/**
 * Decode CSS escapes into the characters they stand for, per css-syntax-3.
 *
 * `url(\\/img/a.png)` and `url(\\2f img/a.png)` both reference `/img/a.png`; left
 * encoded, the reference would not look root-relative and would neither be
 * re-based nor packed into the snapshot.
 *
 * A hex escape may swallow one following whitespace (CRLF counts as one), a
 * backslash before a newline is a line continuation, and a code point that is
 * zero, a lone surrogate, or beyond the Unicode range becomes U+FFFD.
 */
function decodeCssEscapes(raw: string): string {
  if (!raw.includes('\\')) return raw;
  return raw.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(?:\r\n|[\n\r\f])|([\s\S]))?/g,
    (all, hex?: string, literal?: string) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        const invalid = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
        return invalid ? '\ufffd' : String.fromCodePoint(code);
      }
      if (literal !== undefined) return literal; // `\/` is a plain slash
      return all === '\\' ? '\ufffd' : ''; // trailing backslash, else a continuation
    },
  );
}

/** write a reference back as a quoted CSS string, so no escaping subtleties remain */
function quoteCssValue(value: string): string {
  return `"${value.replace(/["\\]|[\u0000-\u001f\u007f]/g, (ch) =>
    ch === '"' || ch === '\\' ? `\\${ch}` : `\\${ch.codePointAt(0)!.toString(16)} `,
  )}"`;
}

/** index of the first non-whitespace byte at or after `from` (no substring copies) */
function skipCssSpace(css: string, from: number): number {
  let i = from;
  while (i < css.length) {
    const code = css.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) break;
    i += 1;
  }
  return i;
}

/** a CSS string literal starting at `start` (which holds the opening quote) */
function readCssString(css: string, start: number): { raw: string; value: string; end: number } {
  const quote = css[start]!;
  let value = '';
  let i = start + 1;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '\\') {
      value += ch + (css[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === quote) return { raw: css.slice(start, i + 1), value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return { raw: css.slice(start), value, end: css.length }; // unterminated — copy verbatim
}

const IDENT_CHAR = /[\w-]/;

/**
 * Rewrite every reference a stylesheet actually makes: `url(...)` tokens and
 * `@import` targets, quoted or not.
 *
 * This walks the CSS rather than pattern-matching it, because the two look
 * identical from the outside: `content:"url(/wiki/help)"` is a display string
 * and must survive untouched, while `background:url(/wiki/help)` two lines down
 * is a reference and must be re-based. Strings, comments and backslash escapes
 * are therefore skipped as units.
 */
function mapCssRefs(css: string, map: (ref: string) => string): string {
  let out = '';
  let i = 0;
  let importTarget = false; // inside `@import`, where a bare string IS the ref
  while (i < css.length) {
    const ch = css[i]!;

    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const stop = close === -1 ? css.length : close + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const { raw, value, end } = readCssString(css, i);
      if (importTarget && value.trim()) {
        const decoded = decodeCssEscapes(value);
        out += decoded === value ? `${ch}${map(value)}${ch}` : quoteCssValue(map(decoded));
      } else {
        out += raw;
      }
      importTarget = false;
      i = end;
      continue;
    }

    if ((ch === 'u' || ch === 'U') && !IDENT_CHAR.test(css[i - 1] ?? '') && /^url\(/i.test(css.slice(i, i + 4))) {
      const token = readUrlToken(css, i, map);
      if (token) {
        out += token.text;
        importTarget = false;
        i = token.end;
        continue;
      }
    }

    if (ch === '@' && /^@import\b/i.test(css.slice(i, i + 8))) {
      out += css.slice(i, i + 7);
      i += 7;
      importTarget = true;
      continue;
    }

    if (ch === ';' || ch === '{' || ch === '}') importTarget = false;
    out += ch;
    i += 1;
  }
  return out;
}

/** one `url(...)` token starting at `start`; null if it never closes */
function readUrlToken(
  css: string,
  start: number,
  map: (ref: string) => string,
): { text: string; end: number } | null {
  const keyword = css.slice(start, start + 4); // `url(`, `URL(`, `Url(` — kept as written
  const valueStart = skipCssSpace(css, start + 4);
  const leading = css.slice(start + 4, valueStart);
  let i = valueStart;

  let quote = '';
  let raw = '';
  let trailing = '';
  const next = css[i];
  if (next === '"' || next === "'") {
    const str = readCssString(css, i);
    quote = next;
    raw = str.value;
    i = str.end;
    const afterString = skipCssSpace(css, i);
    trailing = css.slice(i, afterString);
    i = afterString;
  } else {
    let significant = 0; // length of `raw` up to its last non-whitespace character
    while (i < css.length && css[i] !== ')') {
      if (css[i] === '\\') {
        raw += css[i]! + (css[i + 1] ?? '');
        significant = raw.length;
        i += 2;
        continue;
      }
      const ch = css[i]!;
      raw += ch;
      if (!/\s/.test(ch)) significant = raw.length;
      i += 1;
    }
    // an ESCAPED trailing space belongs to the URL (`url(/img/a\\ )`), so the
    // split point is tracked while scanning rather than trimmed afterwards
    trailing = raw.slice(significant);
    raw = raw.slice(0, significant);
  }

  if (css[i] !== ')') return null; // unterminated — leave the bytes alone
  if (!raw) {
    // `url()` / `url( )` carry no reference; copy the bytes through
    return { text: `${keyword}${css.slice(start + 4, i)})`, end: i + 1 };
  }

  const decoded = decodeCssEscapes(raw);
  const mapped = map(decoded);
  // a value that used escapes comes back as a plain quoted string: same meaning,
  // no chance of re-introducing an escape the re-based path does not need
  const body = decoded === raw ? `${quote}${mapped}${quote}` : quoteCssValue(mapped);
  return { text: `${keyword}${leading}${body}${trailing})`, end: i + 1 };
}

/** attributes whose value is a single URL */
const URL_ATTRS = new Set([
  'src',
  'href',
  'poster',
  'action',
  'formaction',
  'data',
  'manifest',
  'cite',
  'background',
  'xlink:href',
]);
/** attributes whose value is a srcset list */
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/** where in the document a reference sits — the requiredness rules read it */
interface RefContext {
  /** lowercase tag name ('' for a CSS-file or JS-file reference) */
  tag: string;
  /** lowercase attribute name; undefined for a script/style body */
  attr?: string | undefined;
  /** the tag's rel attribute value (link tags), lowercase */
  rel?: string | undefined;
}

/**
 * Walk a built page and hand every url-ish value to `map`, splicing whatever it
 * returns back into the document.
 *
 * Deliberately a small tokenizer rather than one regex over the whole file: an
 * attribute pattern applied blindly also hits `src="…"` inside a `<script>`
 * string, inside an HTML comment, and inside any note that shows HTML in a code
 * block (fenced samples reach the output as literal text — quotes and all).
 * Rewriting those corrupts content that is not a reference. Everything
 * outside a real start tag is therefore copied byte-for-byte, and `<script>` /
 * `<style>` bodies get their own handling.
 *
 * Serialization is not round-tripped through a DOM: the output differs from the
 * input only inside the attribute values (and CSS bodies) that `map` changed.
 *
 * Both callers share this one traversal — the asset-closure collector and the
 * rewriter — so a reference can never be copied into the snapshot without being
 * re-based, or re-based without being copied.
 */
function mapHtmlRefs(
  html: string,
  map: (ref: string, kind: 'url' | 'css' | 'js', ctx: RefContext) => string,
): string {
  let out = '';
  let i = 0;

  /** attributes of one start tag; `end` is the index just past `>` */
  const mapStartTag = (tag: string, tagName: string): string => {
    const relRaw = /(?:^|\s)rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
    const rel = (relRaw?.[1] ?? relRaw?.[2] ?? relRaw?.[3])?.toLowerCase();
    return tag.replace(
      /([^\s"'=<>/]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
      (all, rawName: string, eq: string, _v: string, dq?: string, sq?: string, uq?: string) => {
        const name = rawName.toLowerCase();
        const value = dq ?? sq ?? uq ?? '';
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
        const ctx: RefContext = { tag: tagName, attr: name, rel };
        let mapped: string;
        if (URL_ATTRS.has(name)) mapped = map(value, 'url', ctx);
        else if (SRCSET_ATTRS.has(name)) mapped = mapSrcset(value, (ref) => map(ref, 'url', ctx));
        else if (name === 'style') mapped = mapCssRefs(value, (ref) => map(ref, 'css', ctx));
        else return all;
        // an unquoted value that gained a space/quote must be quoted to stay valid
        const needsQuote = quote === '' && /[\s"'`=<>]/.test(mapped);
        const q = needsQuote ? '"' : quote;
        return `${rawName}${eq}${q}${mapped}${q}`;
      },
    );
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(lt, stop); // comments are content, never references
      i = stop;
      continue;
    }
    const tag = readStartTag(html, lt);
    if (!tag) {
      // closing tag, doctype, processing instruction, or a stray `<`
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? html.length : end + 1;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    out += mapStartTag(tag.raw, tag.name);
    i = tag.end;

    const tagName = tag.name;
    if (tagName !== 'script' && tagName !== 'style') continue;
    if (/\/>$/.test(tag.raw)) continue;

    // raw-text element: its body is CSS or JS, not markup
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
    const rest = html.slice(i);
    const closeAt = rest.search(closeRe);
    const body = closeAt === -1 ? rest : rest.slice(0, closeAt);
    out +=
      tagName === 'style'
        ? mapCssRefs(body, (ref) => map(ref, 'css', { tag: tagName }))
        : // Inline JS is not rewritten wholesale — a string literal there is not
          // reliably a URL. Vite's own emitted `/_astro/…` refs are the exception:
          // unambiguous, and what the island bootstrap needs.
          body.replace(
            /(["'`])(\/_astro\/[^"'`]+)\1/g,
            (_all, q: string, ref: string) => `${q}${map(ref, 'js', { tag: tagName })}${q}`,
          );
    i += closeAt === -1 ? rest.length : closeAt;
  }
  return out;
}

/** a reference whose target is (by extension) a web font */
const FONT_REF = /\.(woff2?|ttf|otf|eot)$/i;

function isFontRef(ref: string): boolean {
  return FONT_REF.test(ref.split('#')[0]!.split('?')[0]!);
}

/**
 * The page cannot render without these; every other reference (page links,
 * preloads, open-graph URLs…) is navigational and stays permissive:
 *  - script src
 *  - stylesheet link href
 *  - img / source src and srcset
 *  - font url() (stylesheets and style blocks/attributes)
 */
function isRequiredRef(ref: string, kind: 'url' | 'css' | 'js', ctx: RefContext): boolean {
  if (kind === 'css') return isFontRef(ref);
  if (kind !== 'url') return false;
  if (ctx.tag === 'script' && ctx.attr === 'src') return true;
  if (ctx.tag === 'link' && ctx.attr === 'href' && (ctx.rel ?? '').split(/\s+/).includes('stylesheet')) {
    return true;
  }
  return (ctx.tag === 'img' || ctx.tag === 'source') && (ctx.attr === 'src' || ctx.attr === 'srcset');
}

/** every url-ish value of a page, in document order (closure collection),
 *  each flagged with whether the snapshot may exist without it */
function collectHtmlRefs(html: string): Array<{ ref: string; required: boolean }> {
  const refs: Array<{ ref: string; required: boolean }> = [];
  mapHtmlRefs(html, (ref, kind, ctx) => {
    refs.push({ ref, required: isRequiredRef(ref, kind, ctx) });
    return ref;
  });
  return refs;
}

/**
 * Re-base a built page for life at the share root, and harden it a little.
 *
 * Call once, on freshly built HTML: the transform is not idempotent by design
 * (a page-relative ref cannot be told apart from an already-re-based one), and
 * `buildSnapshot` always re-reads the page from the build output.
 */
export function rewriteHtml(html: string, pageDir: string): string {
  let out = mapHtmlRefs(html, (ref, kind) => (kind === 'js' ? `.${ref}` : rewriteRef(ref, pageDir)));

  // noindex — the gateway also sends X-Robots-Tag; this covers saved copies
  if (!/name=["']?robots["'\s>]/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1><meta name="robots" content="noindex,nofollow">');
  }

  // Vite's preload helper resolves a chunk's dependencies against the site
  // base '/', which under /s/<id>/ points outside the share; the preload of
  // such a dependency fails and the helper would abort the import. The
  // listener (an external file, so a strict CSP can allow it by path) turns
  // that failure into a no-op: the dynamic import itself is emitted relative
  // (`./chunk.js`) and loads the dependency through its own import graph.
  return out.replace(/<\/head>/i, `<script src="${rewriteRef(`/${PRELOAD_SHIM}`, pageDir)}"></script></head>`);
}

/** the preload-failure shim, copied into every snapshot */
export const PRELOAD_SHIM = '_share/preload.js';
export const PRELOAD_SHIM_SOURCE = 'window.addEventListener("vite:preloadError",function(e){e.preventDefault()});\n';

/**
 * Re-base the refs inside a COPIED stylesheet.
 *
 * An external stylesheet keeps its own place in the snapshot (`_astro/app.css`),
 * so its *relative* refs (`url(./font.woff2)`) still resolve and must be left
 * alone. Its *root-relative* refs (`url(/_astro/font.woff2)`) are the problem:
 * a browser resolves those against the origin, which under `/s/<id>/` is the
 * gateway root — outside the share. Astro emits exactly this form (a typical
 * page's CSS carries hundreds, KaTeX's web fonts among them), so without this
 * every share renders with fallback glyphs while the font bytes sit unused in
 * the tarball.
 *
 * `cssDir` is the stylesheet's own directory inside the snapshot (`_astro`, or
 * '' at the root); each rewritten ref is the path from there to the target.
 */
export function rewriteCssFile(css: string, cssDir: string): string {
  return mapCssRefs(css, (ref) => {
    if (!ref.startsWith('/') || ref.startsWith('//')) return ref;
    const split = ref.search(/[#?]/);
    const path = split === -1 ? ref : ref.slice(0, split);
    const suffix = split === -1 ? '' : ref.slice(split);
    const rel = posix.relative(cssDir, normalizeSitePath(path.slice(1)));
    return `${rel.startsWith('..') ? rel : `./${rel}`}${suffix}`;
  });
}

/* ---------------- entry ---------------- */

/**
 * Build (or reuse) the WIKI-free static site and cut a self-contained
 * single-page snapshot for `noteRoute`. The caller owns (and removes) the
 * returned temp dir.
 */
export async function buildSnapshot(
  root: string,
  noteRoute: string,
  onProgress: Progress = () => undefined,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const outDir = await ensureBuild(root, onProgress, signal);
  signal?.throwIfAborted();

  // route → built page (directory format first, file format fallback);
  // every candidate must resolve inside the build output
  const routePath = noteRoute.replace(/\/+$/, '');
  const candidates = [
    join(outDir, routePath, 'index.html'),
    routePath ? join(outDir, `${routePath}.html`) : '',
  ]
    .filter(Boolean)
    .map((p) => containedPath(outDir, p))
    .filter((p): p is string => p !== null);
  const htmlPath = candidates.find((p) => existsSync(p));
  if (!htmlPath) {
    throw new Error(`route '${noteRoute}' not found in the static build (.wiki/share-dist)`);
  }

  onProgress('Collecting the page asset closure…');
  const html = readFileSync(htmlPath, 'utf8');
  const snapDir = await mkdtemp(join(tmpdir(), 'inkbrush-share-'));
  // the temp dir is owned by the caller only once this returns; any failure
  // before that removes it here
  try {
    // walk the closure: html refs → css url()/`@import` → js import graph.
    // A required ref (see isRequiredRef) that resolves inside the site must
    // exist as a file, or the snapshot fails naming the reference; page
    // links and other navigational refs are skipped silently.
    const files: string[] = [];
    const visited = new Set<string>();
    const pageName = relative(outDir, htmlPath).split(sep).join('/');
    const queue: Array<{ ref: string; fromDir: string; from: string; required: boolean }> =
      collectHtmlRefs(html).map(({ ref, required }) => ({
        ref,
        fromDir: dirname(htmlPath),
        from: pageName,
        required,
      }));
    while (queue.length) {
      const { ref, fromDir, from, required } = queue.shift()!;
      const abs = resolveRef(ref, fromDir, outDir);
      if (!abs || visited.has(abs)) continue;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        stat = null;
      }
      if (!stat?.isFile()) {
        // directories = other routes; symlinks are never packed
        if (required) {
          throw new Error(
            `snapshot failed: the page requires asset '${ref}' (referenced by ${from}) but the build output has no such file`,
          );
        }
        continue; // e.g. <a href="/wiki/other"> — page links are not assets
      }
      visited.add(abs);
      const rel = relative(outDir, abs);
      const dest = join(snapDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      files.push(rel);
      if (abs.endsWith('.css')) {
        const css = readFileSync(abs, 'utf8');
        assertClean(css, rel);
        for (const next of collectCssUrls(css)) {
          queue.push({ ref: next, fromDir: dirname(abs), from: rel, required: isFontRef(next) });
        }
        // copied with its refs re-based, not byte-for-byte (see rewriteCssFile)
        const cssDir = dirname(rel).split(sep).join('/');
        writeFileSync(dest, rewriteCssFile(css, cssDir === '.' ? '' : cssDir));
        continue;
      }
      copyFileSync(abs, dest);
      if (/\.m?js$/.test(abs)) {
        const js = readFileSync(abs, 'utf8');
        assertClean(js, rel);
        for (const next of collectJsRefs(js)) {
          queue.push({ ref: next, fromDir: dirname(abs), from: rel, required: false });
        }
      }
    }

    const pageDir = relative(outDir, dirname(htmlPath)).split(sep).join('/');
    const rewritten = rewriteHtml(html, pageDir);
    assertClean(executableMarkup(rewritten).replace(EXEMPT_TAG, ''), 'index.html');
    writeFileSync(join(snapDir, 'index.html'), rewritten);
    mkdirSync(join(snapDir, dirname(PRELOAD_SHIM)), { recursive: true });
    writeFileSync(join(snapDir, PRELOAD_SHIM), PRELOAD_SHIM_SOURCE);
    files.push(PRELOAD_SHIM);
    onProgress(`Snapshot ready (${files.length} assets)`);
    return { dir: snapDir, files };
  } catch (err) {
    rmSync(snapDir, { recursive: true, force: true });
    throw err;
  }
}
