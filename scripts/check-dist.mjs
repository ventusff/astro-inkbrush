#!/usr/bin/env node
/**
 * check-dist — build-output check: every site-internal reference a reader can
 * click in the `astro build` dist must actually exist. It catches classes of
 * link rot that a green build hides:
 *   - internal links/assets pointing at files that don't exist;
 *   - in-page anchors pointing at ids that don't exist;
 *   - duplicated locale segments in paths (/en/en/ — the classic i18n
 *     fallback prefix-stacking scar);
 *   - <a> nested inside <a> (the HTML parser closes the outer one early and
 *     buttons fall out of their cards);
 *   - leftover KaTeX render errors (class="katex-error" — the formula shows
 *     as red text).
 *
 * Usage (from the site root, after a build):
 *   node <engine>/scripts/check-dist.mjs dist --base /docs/
 *
 *   --base <path>    the site's mount prefix (astro config `base`; default /)
 *   --allow <prefix> internal prefixes to wave through (repeatable; paths not
 *                    in dist, e.g. runtime endpoints. /api/ is allowed by
 *                    default)
 *   --skip <dir>     dist subdirectories not to check (repeatable; e.g.
 *                    subtrees whose bundles are built by another site —
 *                    each build checks its own output)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const dist = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist');
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
let base = many('base')[0] ?? '/';
if (!base.endsWith('/')) base += '/';
const allow = [...many('allow'), '/api/'];
const skips = new Set(many('skip'));

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!skips.has(relative(dist, p))) yield* htmlFiles(p);
    } else if (name.endsWith('.html')) yield p;
  }
}

/** a target inside a --skip subtree = another build's territory, counts as reachable */
function inSkipped(abs) {
  const rel = relative(dist, abs);
  return [...skips].some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** href → target file in dist (absolute path when resolvable; external /
 *  allowed / non-file returns null) */
function targetOf(url, fromDir) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return null; // external, mailto:, data:, …
  let path = url.split('#')[0].split('?')[0];
  if (path === '') return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return { missing: `undecodable URL: ${url}` };
  }
  let abs;
  if (path.startsWith('/')) {
    if (allow.some((p) => path.startsWith(p) || path.startsWith(base.slice(0, -1) + p))) return null;
    if (!path.startsWith(base)) return { missing: `internal absolute link missing the mount prefix ${base}: ${path}` };
    abs = join(dist, path.slice(base.length));
  } else {
    abs = resolve(fromDir, path);
  }
  if (inSkipped(abs)) return null;
  if (existsSync(abs) && statSync(abs).isFile()) return { file: abs };
  for (const candidate of [join(abs, 'index.html'), `${abs}.html`]) {
    if (existsSync(candidate)) return { file: candidate };
  }
  return { missing: path };
}

/** template strings inside inline scripts/styles (href="${e.href}") are not
 *  page references — strip those blocks before scanning attributes */
function withoutCode(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
}

const idCache = new Map();
function idsOf(file) {
  let ids = idCache.get(file);
  if (!ids) {
    ids = new Set([...readFileSync(file, 'utf8').matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
    idCache.set(file, ids);
  }
  return ids;
}

const TAG = /<[a-zA-Z][^>]*>/g;
const ATTR = /\b(?:href|src|poster)=["']([^"']+)["']/g;
const SRCSET = /\b(?:srcset|imagesrcset)=["']([^"']+)["']/g;

let pages = 0;
let refs = 0;
const problems = [];
for (const file of htmlFiles(dist)) {
  pages += 1;
  const rel = relative(dist, file);
  const raw = readFileSync(file, 'utf8');
  const html = withoutCode(raw);

  if (/(?:^|\/)(en|de|zh)\/\1\//.test(rel)) problems.push(`${rel}: duplicated locale segment in the path`);
  if (raw.includes('katex-error')) problems.push(`${rel}: leftover KaTeX render error (the page shows a red formula)`);

  // <a> nested in <a>: the HTML parser closes the outer one early
  let depth = 0;
  for (const tag of html.matchAll(/<a[\s>]|<\/a>/g)) {
    depth += tag[0] === '</a>' ? -1 : 1;
    if (depth > 1) {
      problems.push(`${rel}: <a> nested inside <a> — browsers close the outer one early`);
      break;
    }
  }

  // only attributes inside REAL tags count — escaped example HTML in prose
  // (&#x3C;img src='…'>) is not a reference
  const urls = [...html.matchAll(TAG)].flatMap((t) => [
    ...[...t[0].matchAll(ATTR)].map((m) => m[1]),
    ...[...t[0].matchAll(SRCSET)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])),
  ]);
  for (const url of urls) {
    refs += 1;
    const target = targetOf(url, join(file, '..'));
    if (target === null) continue;
    if (target.missing !== undefined) {
      problems.push(`${rel}: link target does not exist → ${url}`);
      continue;
    }
    const frag = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
    if (frag && !idsOf(target.file).has(decodeURIComponent(frag))) {
      // redirect stub pages (http-equiv=refresh) have no body ids — the real
      // page honours the anchor, so it isn't validated here
      if (!readFileSync(target.file, 'utf8').includes('http-equiv="refresh"')) {
        problems.push(`${rel}: anchor #${decodeURIComponent(frag)} does not exist on the target page → ${url}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ dist check: ${problems.length} problems (${pages} pages / ${refs} references):\n`);
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ dist check passed: ${pages} pages, ${refs} internal references all reachable; no dangling anchors / locale doubling / nested <a> / KaTeX errors`);
