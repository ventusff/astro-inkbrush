#!/usr/bin/env node
/**
 * check-dist — build-output check for an `astro build` dist: every
 * site-internal reference a browser would fetch or follow must resolve to a
 * file in the dist, and the output must carry none of the CMS. Findings:
 *
 *   - a reference whose target is not in the dist — from any URL-bearing
 *     attribute (href, src, srcset/imagesrcset candidates, poster, data,
 *     action, formaction, cite, longdesc, manifest, ping), a meta-refresh
 *     target, or a url()/@import inside an inline style, a <style> element
 *     or a stylesheet under the dist;
 *   - a reference that escapes the dist — a relative or absolute path
 *     resolving outside the dist's real path, or a symlinked target whose
 *     real file lives outside it; such a reference is an escape finding,
 *     never validated against the host filesystem;
 *   - a fragment naming an id that is not on the target page (same-page
 *     fragments included; redirect stubs carrying http-equiv=refresh are
 *     not inspected for ids);
 *   - an internal absolute URL that lacks the mount prefix (--base);
 *   - a duplicated locale segment in a page path (/en/en/);
 *   - an <a> the HTML parser closes implicitly — a nested <a>, or one left
 *     open across a block boundary;
 *   - KaTeX render-error residue (an element with class katex-error);
 *   - CMS injection: a script (inline or bundled under the dist) that
 *     references the inkbrush client API (/api/wiki/) or carries the string
 *     "inkbrush", any HTML attribute value carrying /api/wiki/ (action,
 *     href, data-*, …), rehypeWikiBlocks stamps (data-wiki-*) in the
 *     markup, `.wiki-` chrome selectors in a stylesheet or a <style>
 *     element, or a textual asset (.json .txt .svg .webmanifest .xml)
 *     containing "inkbrush" (case-insensitive; binary assets are not
 *     decoded). Page prose is exempt — a manual may discuss the CMS — and
 *     the `inkbrush-note` meta is site-owned identity markup present in
 *     every build by contract; neither is a finding. The marker strings are
 *     shared with the share-snapshot hygiene check
 *     (src/lib/pollution-markers.ts).
 *
 * A page's <base href> re-bases its relative references by URL semantics —
 * whether or not anything exists at the base target — and a reference whose
 * re-based target is not in the dist is a finding as usual.
 *
 * HTML is parsed with parse5 (the WHATWG parser Astro itself uses), so only
 * real elements count — escaped markup in prose is text. Malformed input is
 * never fatal: a file that cannot be read or checked is itself a finding.
 * The dist walker follows symlinks only while their real path stays inside
 * the dist's real path and visits each real directory once.
 *
 * Usage (from the site root, after a build):
 *   node <engine>/scripts/check-dist.mjs dist --base /docs/
 *
 *   <dir>            the build output directory (default dist)
 *   --base <path>    the site's mount prefix (astro config `base`; default /)
 *   --allow <prefix> internal absolute prefixes to wave through (repeatable;
 *                    paths served at runtime rather than from the dist;
 *                    /api/ is allowed by default — /api/wiki/ only via an
 *                    explicit --allow, the operator's declaration of a
 *                    deliberate cross-plane link)
 *   --skip <dir>     dist subdirectories not to check (repeatable; a subtree
 *                    built by another site counts as reachable)
 *   --allow-empty    accept a build output that holds no files at all
 *                    (without it, an empty dist fails — it certifies
 *                    nothing)
 *   --help           print this usage
 *
 * Exit code: 0 clean, 1 findings (a nonexistent or — without --allow-empty —
 * empty <dir> included), 2 usage error.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'parse5';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const { CMS_API_MARKER, CMS_STAMP_MARKER } = await import(
  pathToFileURL(join(engineRoot, 'src/lib/pollution-markers.ts')).href
);

/* ---------------- URL-bearing syntax ---------------- */

const SPACE = new Set([' ', '\t', '\n', '\f', '\r']);

/** the URLs of a srcset / imagesrcset value, per the HTML candidate parsing
 *  algorithm: a URL runs to whitespace (commas inside it are part of it),
 *  trailing commas terminate a candidate, descriptors run to the next comma
 *  outside parentheses */
export function parseSrcset(value) {
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (SPACE.has(value[i]) || value[i] === ',')) i += 1;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !SPACE.has(value[i])) i += 1;
    let url = value.slice(start, i);
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let depth = 0;
      while (i < value.length) {
        const c = value[i];
        i += 1;
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        else if (c === ',' && depth <= 0) break;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

/** the target of a meta refresh `content` ("0; url=/x/", "5;URL='/x'"); null when it only reloads */
export function metaRefreshUrl(content) {
  const m = /^\s*[\d.]*\s*[;,]\s*(?:url\s*=\s*)?(.*)$/i.exec(content);
  if (!m) return null;
  const url = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return url || null;
}

const IDENT_CHAR = /[A-Za-z0-9_-]/;
const HEX = /[0-9A-Fa-f]/;

/**
 * url() and @import targets of a stylesheet or an inline style value, read
 * with CSS token rules: comments and strings are skipped (a `url(` inside a
 * string is text), escapes are decoded, `url(` counts only as a token start.
 */
export function cssUrls(css) {
  const urls = [];
  const n = css.length;
  let i = 0;

  /** at a backslash: decode one escape, leave i after it */
  const escape = () => {
    i += 1;
    if (i >= n) return '';
    if (HEX.test(css[i])) {
      let hex = '';
      while (i < n && hex.length < 6 && HEX.test(css[i])) hex += css[i++];
      if (i < n && /[ \t\n\f\r]/.test(css[i])) i += 1;
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code);
    }
    if (css[i] === '\n' || css[i] === '\f' || css[i] === '\r') {
      i += 1;
      return '';
    }
    return css[i++];
  };
  /** at an opening quote: read the string body, leave i after the closing quote */
  const string = () => {
    const quote = css[i++];
    let out = '';
    while (i < n && css[i] !== quote && css[i] !== '\n') {
      if (css[i] === '\\') out += escape();
      else out += css[i++];
    }
    if (css[i] === quote) i += 1;
    return out;
  };
  const skipSpace = () => {
    while (i < n && /[ \t\n\f\r]/.test(css[i])) i += 1;
  };

  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === '"' || c === "'") {
      string();
    } else if (c === '@' && /^@import$/i.test(css.slice(i, i + 7)) && !IDENT_CHAR.test(css[i + 7] ?? '')) {
      // the at-keyword ends at the first non-ident character: a quoted URL
      // may follow with or without whitespace (`@import"x.css"` is valid
      // CSS); `url(…)` after it is collected by the url() branch
      i += 7;
      skipSpace();
      if (css[i] === '"' || css[i] === "'") urls.push(string());
    } else if (/^url\(/i.test(css.slice(i, i + 4)) && !(i > 0 && IDENT_CHAR.test(css[i - 1]))) {
      i += 4;
      skipSpace();
      let url = '';
      if (css[i] === '"' || css[i] === "'") {
        url = string();
      } else {
        while (i < n && css[i] !== ')' && !/[ \t\n\f\r"']/.test(css[i])) {
          if (css[i] === '\\') url += escape();
          else url += css[i++];
        }
      }
      skipSpace();
      if (css[i] === ')') i += 1;
      if (url.trim()) urls.push(url.trim());
    } else if (IDENT_CHAR.test(c)) {
      while (i < n && IDENT_CHAR.test(css[i])) i += 1;
    } else {
      i += 1;
    }
  }
  return urls;
}

/* ---------------- one HTML document ---------------- */

const URL_ATTRS = new Set(['href', 'src', 'poster', 'data', 'action', 'formaction', 'cite', 'longdesc', 'manifest']);

/* the marker strings live in src/lib/pollution-markers.ts, shared with the
 * share-snapshot hygiene check so the two enforcers cannot drift; the
 * `inkbrush-note` meta exemption is stated there */
const hasApiMark = (text) => text.includes(CMS_API_MARKER);
const hasStampMark = (text) => text.includes(CMS_STAMP_MARKER);

function textOf(node) {
  return (node.childNodes ?? []).map((c) => c.value ?? '').join('');
}

/**
 * Parse one document and collect what the dist check needs from it:
 * references (with the attribute family they came from), ids a fragment can
 * target (`id`, and `name` on <a>), the <base href>, whether it is a
 * meta-refresh redirect stub, anchors the parser closed implicitly, KaTeX
 * error elements, and CMS markers.
 */
export function analyzeHtml(html) {
  const out = {
    /** @type {{ url: string, from: string }[]} */
    refs: [],
    ids: new Set(),
    baseHref: undefined,
    redirect: false,
    implicitAnchors: [],
    katexErrors: 0,
    cmsScripts: 0,
    cmsStyles: 0,
    /** attribute values carrying the client API marker */
    cmsAttrs: [],
    wikiStamps: 0,
  };
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  // an <a> the parser reconstructs after an implicit close shares its start tag's location with the original
  const implicitAt = new Set();
  const ref = (url, from) => {
    if (url.trim()) out.refs.push({ url: url.trim(), from });
  };
  const walk = (node) => {
    if (node.tagName) {
      const tag = node.tagName;
      const attr = (name) => node.attrs.find((a) => a.name === name)?.value;
      for (const { name, value } of node.attrs) {
        // every attribute value, URL-bearing or not (action, href, data-*,
        // event handlers…), is scanned for the client API marker
        if (hasApiMark(value)) out.cmsAttrs.push(value);
        if (URL_ATTRS.has(name)) {
          if (!(tag === 'base' && name === 'href')) ref(value, name);
        } else if (name === 'srcset' || name === 'imagesrcset') {
          for (const u of parseSrcset(value)) ref(u, name);
        } else if (name === 'ping') {
          for (const u of value.split(/\s+/)) ref(u, name);
        } else if (name === 'style') {
          for (const u of cssUrls(value)) ref(u, 'style');
        } else if (name === 'id') {
          out.ids.add(value);
        } else if (name.startsWith(CMS_STAMP_MARKER)) {
          out.wikiStamps += 1;
        }
      }
      if (tag === 'a') {
        const name = attr('name');
        if (name) out.ids.add(name);
        const loc = node.sourceCodeLocation;
        if (loc && !loc.endTag && !implicitAt.has(loc.startOffset)) {
          implicitAt.add(loc.startOffset);
          out.implicitAnchors.push(attr('href') ?? '');
        }
      }
      if (tag === 'base' && out.baseHref === undefined) out.baseHref = attr('href');
      if (tag === 'meta' && /^refresh$/i.test(attr('http-equiv') ?? '')) {
        out.redirect = true;
        const url = metaRefreshUrl(attr('content') ?? '');
        if (url) ref(url, 'refresh');
      }
      if (/(?:^|\s)katex-error(?:\s|$)/.test(attr('class') ?? '')) out.katexErrors += 1;
      if (tag === 'style') {
        const css = textOf(node);
        for (const u of cssUrls(css)) ref(u, 'style');
        return;
      }
      if (tag === 'script') {
        const js = textOf(node);
        if (hasApiMark(js) || hasStampMark(js)) out.cmsScripts += 1;
        return;
      }
      if (tag === 'template' && node.content) walk(node.content);
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(doc);
  return out;
}

/* ---------------- the dist check ---------------- */

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** dist files (beyond pages, stylesheets and scripts) that are text and may
 *  be decoded for the component-name sweep; everything else is binary */
const TEXTUAL_ASSET = /\.(?:json|txt|svg|webmanifest|xml)$/i;

/**
 * Check a built dist. Returns counts and the finding list (strings, one per
 * problem, de-duplicated, in discovery order); never throws for dist content.
 */
export function checkDist(distDir, options = {}) {
  const dist = resolve(distDir);
  let base = options.base ?? '/';
  if (!base.endsWith('/')) base += '/';
  // an explicit --allow is the operator's declaration of a deliberate
  // reference — it overrides even the /api/wiki/ pollution ruling (a site
  // co-deploying the editor may link into its sign-in from static pages);
  // the built-in /api/ default never does
  const explicitAllow = options.allow ?? [];
  const allow = [...explicitAllow, '/api/'];
  const skips = new Set((options.skip ?? []).map((d) => d.replace(/\/+$/, '')));
  const problems = [];
  const counts = { pages: 0, stylesheets: 0, scripts: 0, assets: 0, refs: 0 };
  const rel = (abs) => relative(dist, abs).replaceAll('\\', '/');

  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    return { ...counts, problems: [`${dist}: not a directory`] };
  }
  const distReal = realpathSync(dist);
  const insideLexical = (abs) => abs === dist || abs.startsWith(dist + sep);
  const insideReal = (real) => real === distReal || real.startsWith(distReal + sep);

  const inSkipped = (abs) => {
    const r = rel(abs);
    return [...skips].some((d) => r === d || r.startsWith(`${d}/`));
  };

  // symlinks are followed only while their real path stays inside the
  // dist's real path, and each real directory is visited once — a symlink
  // cycle cannot recurse and a link out of the dist is not scanned
  const visitedDirs = new Set([distReal]);
  function* files(dir, realDir) {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      problems.push(`${rel(dir) || '.'}: could not be read — ${err.message}`);
      return;
    }
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, entry.name);
      let real = join(realDir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          real = realpathSync(p);
          const stat = statSync(real);
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
        if (!insideReal(real)) {
          problems.push(`${rel(p)}: symlink escapes the build output → ${real}`);
          continue;
        }
      }
      if (isDirectory) {
        if (inSkipped(p) || visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        yield* files(p, real);
      } else if (isFile) {
        yield p;
      }
    }
  }

  /** a reference → { file } when it names a dist file, { missing, reason? }
   *  when not (reason set when the miss is not a plain absent file), null
   *  when out of scope (external, allowed, or query-only). A target outside
   *  the dist — lexically, or through a symlink — is an escape finding and
   *  is never validated against the host filesystem. */
  function targetOf(url, fromDir) {
    if (EXTERNAL.test(url)) return null;
    let path = url.split('#')[0].split('?')[0];
    if (path === '') return null;
    try {
      path = decodeURIComponent(path);
    } catch {
      return { missing: true, reason: `undecodable URL → ${url}` };
    }
    let abs;
    if (path.startsWith('/')) {
      // the /api/ allowlist (and any --allow) never waves through the CMS's
      // own API: a /api/wiki/ reference is pollution, not runtime routing
      const hit = (p) => path.startsWith(p) || path.startsWith(base.slice(0, -1) + p);
      if (allow.some(hit) && (!path.includes(CMS_API_MARKER) || explicitAllow.some(hit))) return null;
      if (!path.startsWith(base)) {
        return { missing: true, reason: `internal absolute link missing the mount prefix ${base} → ${url}` };
      }
      abs = join(dist, path.slice(base.length));
    } else {
      abs = resolve(fromDir, path);
    }
    if (!insideLexical(abs)) {
      return { missing: true, reason: `reference escapes the build output → ${url}` };
    }
    if (inSkipped(abs)) return null;
    for (const candidate of [abs, join(abs, 'index.html'), `${abs}.html`]) {
      let stat;
      try {
        stat = statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (!insideReal(realpathSync(candidate))) {
        return { missing: true, reason: `reference escapes the build output (symlinked target) → ${url}` };
      }
      return { file: candidate };
    }
    return { missing: true };
  }

  const analyses = new Map();
  const analysisOf = (file) => {
    let a = analyses.get(file);
    if (!a) {
      a = analyzeHtml(readFileSync(file, 'utf8'));
      analyses.set(file, a);
    }
    return a;
  };

  const fragmentOf = (url) => {
    const i = url.indexOf('#');
    return i < 0 ? '' : url.slice(i + 1);
  };

  function checkPage(file) {
    const page = rel(file);
    const a = analysisOf(file);

    if (/(?:^|\/)([a-z]{2}(?:-[a-z]{2,4})?)\/\1\//i.test(page)) {
      problems.push(`${page}: duplicated locale segment in the path`);
    }
    if (a.katexErrors > 0) problems.push(`${page}: leftover KaTeX render error (the page shows a red formula)`);
    for (const href of a.implicitAnchors) {
      problems.push(
        `${page}: <a href="${href}"> is closed by the parser, not by its own </a> — a nested <a>, or one left open across a block boundary`,
      );
    }
    if (a.cmsScripts > 0) {
      problems.push(`${page}: CMS injection — an inline script references the inkbrush client (${CMS_API_MARKER} or ${CMS_STAMP_MARKER})`);
    }
    if (a.wikiStamps > 0) {
      problems.push(`${page}: CMS injection — rehypeWikiBlocks stamps (${CMS_STAMP_MARKER}*) in a static build`);
    }
    const cmsAttrs = a.cmsAttrs.filter((v) => !explicitAllow.some((p) => v.includes(p)));
    if (cmsAttrs.length > 0) {
      problems.push(`${page}: CMS injection — an attribute value references the inkbrush client API (${CMS_API_MARKER})`);
    }

    // <base href> re-bases every path reference by URL semantics alone — it
    // applies whether or not anything exists at the base target. A relative
    // base first resolves against the page's own URL; each relative
    // reference then resolves in the base URL's directory. Fragment-only
    // references stay on the page.
    const fromDir = dirname(file);
    let refBase = null;
    if (a.baseHref !== undefined && !EXTERNAL.test(a.baseHref)) {
      const rawBase = a.baseHref.split('#')[0].split('?')[0];
      if (rawBase) {
        const pageDir = rel(fromDir);
        const pageDirUrl = pageDir && pageDir !== '.' ? `${base}${pageDir}/` : base;
        let resolved = rawBase.startsWith('/') ? rawBase : posix.resolve(pageDirUrl, rawBase);
        if (rawBase.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
        refBase = resolved.slice(0, resolved.lastIndexOf('/') + 1);
      }
    }
    const applyBase = (url) => {
      if (refBase === null || EXTERNAL.test(url) || url.startsWith('/')) return url;
      const m = /^([^?#]*)([?#][\s\S]*)?$/.exec(url);
      if (!m[1]) return url;
      let path = posix.resolve(refBase, m[1]);
      if (m[1].endsWith('/') && !path.endsWith('/')) path += '/';
      return path + (m[2] ?? '');
    };

    for (const { url } of a.refs) {
      counts.refs += 1;
      const frag = fragmentOf(url);
      const target = url.startsWith('#') ? { file } : targetOf(applyBase(url), fromDir);
      if (target === null) continue;
      if (target.missing) {
        problems.push(`${page}: ${target.reason ?? `link target does not exist → ${url}`}`);
        continue;
      }
      if (!frag || frag === 'top' || !target.file.endsWith('.html')) continue;
      let id;
      try {
        id = decodeURIComponent(frag);
      } catch {
        problems.push(`${page}: undecodable fragment → ${url}`);
        continue;
      }
      const t = analysisOf(target.file);
      if (!t.redirect && !t.ids.has(id)) {
        const where = target.file === file ? 'on this page' : 'on the target page';
        problems.push(`${page}: anchor #${id} does not exist ${where} → ${url}`);
      }
    }
  }

  function checkStylesheet(file) {
    const sheet = rel(file);
    const css = readFileSync(file, 'utf8');
    // dormant chrome selectors (.wiki-*) are a paired design layer's skin,
    // not pollution; only executable markers count
    for (const url of cssUrls(css)) {
      counts.refs += 1;
      const target = targetOf(url, dirname(file));
      if (target?.missing) problems.push(`${sheet}: ${target.reason ?? `url() target does not exist → ${url}`}`);
    }
  }

  function checkScript(file) {
    const js = readFileSync(file, 'utf8');
    if (hasApiMark(js)) {
      problems.push(`${rel(file)}: CMS injection — a script bundle references the inkbrush client API (${CMS_API_MARKER})`);
    } else if (hasStampMark(js)) {
      problems.push(`${rel(file)}: CMS injection — a script bundle carries ${CMS_STAMP_MARKER} stamps`);
    }
  }

  /** textual assets: executable markers only — site data may name the
   *  engine, and a paired design layer ships dormant chrome selectors */
  function checkAsset(file) {
    if (!TEXTUAL_ASSET.test(file)) return;
    const text = readFileSync(file, 'utf8');
    if (hasApiMark(text) || hasStampMark(text)) {
      problems.push(`${rel(file)}: CMS injection — an asset references the inkbrush client (${CMS_API_MARKER} or ${CMS_STAMP_MARKER})`);
    }
  }

  const walked = [...files(dist, distReal)].sort();
  if (walked.length === 0 && options.allowEmpty !== true) {
    problems.push(`${dist}: the build output holds no files — an empty dist certifies nothing (pass --allow-empty when that is intended)`);
  }
  for (const file of walked) {
    const check = file.endsWith('.html')
      ? (counts.pages += 1, checkPage)
      : file.endsWith('.css')
        ? (counts.stylesheets += 1, checkStylesheet)
        : /\.m?js$/.test(file)
          ? (counts.scripts += 1, checkScript)
          : (counts.assets += 1, checkAsset);
    try {
      check(file);
    } catch (err) {
      problems.push(`${rel(file)}: could not be checked — ${err.message}`);
    }
  }

  return { ...counts, problems: [...new Set(problems)] };
}

/* ---------------- CLI ---------------- */

const USAGE = `usage: check-dist.mjs [<dir>] [--base <path>] [--allow <prefix>]... [--skip <dir>]... [--allow-empty]

  <dir>            the build output directory (default dist)
  --base <path>    the site's mount prefix (astro config \`base\`; default /)
  --allow <prefix> internal absolute prefixes to wave through (repeatable;
                   paths served at runtime rather than from the dist; /api/
                   is allowed by default)
  --skip <dir>     dist subdirectories not to check (repeatable; a subtree
                   built by another site counts as reachable)
  --allow-empty    accept a build output that holds no files at all (without
                   it, an empty dist fails — it certifies nothing)
  --help           print this usage

Checks every file under <dir>: internal references (URL attributes, srcset
candidates, meta refresh, CSS url()/@import) must resolve to a dist file —
never escape it — and fragments to an id on the target page; no duplicated
locale segment, no implicitly closed <a>, no KaTeX error residue, no CMS
injection (inkbrush client API references in scripts or in any HTML
attribute value, rehypeWikiBlocks stamps, .wiki- chrome selectors, or the
string "inkbrush" in any script, stylesheet or textual asset — page prose
and the site-owned inkbrush-note meta are exempt; binary assets are not
decoded). A nonexistent <dir> and an empty one (without --allow-empty) are
findings.
Exit code: 0 clean, 1 findings, 2 usage error.`;

export function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const valued = new Set(['--base', '--allow', '--skip']);
  const flags = new Set(['--allow-empty']);
  if (valued.has(argv[argv.length - 1])) {
    console.error(`${argv[argv.length - 1]} requires a value\n\n${USAGE}`);
    return 2;
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const unknown = argv.filter((a) => a.startsWith('--') && !valued.has(a) && !flags.has(a));
  if (positional.length > 1 || unknown.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const many = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

  const result = checkDist(positional[0] ?? 'dist', {
    base: many('base')[0],
    allow: many('allow'),
    skip: many('skip'),
    allowEmpty: argv.includes('--allow-empty'),
  });
  const scope = `${result.pages} pages / ${result.stylesheets} stylesheets / ${result.scripts} scripts / ${result.assets} assets / ${result.refs} references`;
  if (result.problems.length > 0) {
    console.error(`✗ dist check: ${result.problems.length} problems (${scope}):\n`);
    for (const p of result.problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(
    `✓ dist check passed: ${scope} all reachable; no dangling anchors / locale doubling / implicitly closed <a> / KaTeX errors / CMS injection`,
  );
  return 0;
}

function isEntry() {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(main(process.argv.slice(2)));
