#!/usr/bin/env node
/**
 * check-wikilinks — a [[wikilink]] consistency lint for content repos.
 *
 * The page pipeline deliberately never fails a build on a broken wikilink
 * (a miss renders span.wikilink-dead); strict checking belongs to lint —
 * this script. It reports:
 *
 *   FAIL missing     the target resolves to no note
 *   FAIL ambiguous   an alias/brand/title matches more than one note
 *   WARN anchor      [[target#heading]] whose heading isn't found in the
 *                    target note (best-effort: h2–h4 text slugs + explicit
 *                    `{#id}` attributes)
 *   WARN unmatched   a stray unclosed `[[` left in prose (typically torn
 *                    apart by a table pipe or a linkReference)
 *   WARN crlf        the file contains CRLF line endings (frontmatter
 *                    parsing is LF-only, so titles/aliases silently degrade)
 *
 * Why the engine ships this script: the regex, the masking, the resolution
 * order and the anchor slugger are imported straight from the package's own
 * wikilinks library — a checker that restates them will drift, and a
 * drifted checker is worse than none.
 *
 * Usage (from the site or content repo root):
 *   node <engine>/scripts/check-wikilinks.mjs <content-dir> [flags]
 *
 *   --strict                 exit 1 when any FAIL was reported (WARNs never
 *                            affect the exit code)
 *   --locale-prefix <p/>     locale-mirror prefix (repeatable; replaces the
 *                            default `en/ de/` set when given) — a link
 *                            inside a mirrored note resolves to its own
 *                            locale's mirror first
 *   --extra <dir>:<prefix>   an extra flat corpus of `*.md` files whose ids
 *                            are `<prefix>/<relative-path-minus-.md>`
 *                            (repeatable) — e.g. a card vault:
 *                            --extra src/content/vault/cards:cards
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const {
  WIKILINK_RE,
  buildWikilinkResolver,
  defaultSlugify,
  extractWikilinks,
  maskNonProse,
  noteInfoFromSource,
  scanNotes,
} = await import(pathToFileURL(join(engineRoot, 'src/lib/wikilinks.ts')).href);

/* ---------------- CLI ---------------- */

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--locale-prefix' && args[i - 1] !== '--extra');
if (positional.length !== 1) {
  console.error('usage: check-wikilinks.mjs <content-dir> [--strict] [--locale-prefix <p/>]... [--extra <dir>:<idPrefix>]...');
  process.exit(2);
}
const root = resolve(positional[0]);
const strict = args.includes('--strict');
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const localePrefixes = many('locale-prefix');
const locales = (localePrefixes.length > 0 ? localePrefixes : ['en/', 'de/']).map((prefix) => ({
  code: prefix.replace(/\/+$/, ''),
  prefix,
}));
const extras = many('extra').map((spec) => {
  const idx = spec.lastIndexOf(':');
  if (idx <= 0) {
    console.error(`--extra expects <dir>:<idPrefix>, got: ${spec}`);
    process.exit(2);
  }
  return { dir: resolve(spec.slice(0, idx)), prefix: spec.slice(idx + 1).replace(/\/+$/, '') };
});

/* ---------------- corpus ---------------- */

// The main corpus comes from the library's own scanner (identical skip rules
// and frontmatter parsing as the site's resolver); texts are re-read by id
// since the standard layout makes the path derivable.
const noteText = new Map(); // id → source
const pathOfNote = (id) => {
  for (const ext of ['mdx', 'md']) {
    const p = join(root, id, `index.${ext}`);
    try {
      statSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
};

const notes = scanNotes(root);
for (const n of notes) {
  const p = pathOfNote(n.id);
  if (p) noteText.set(n.id, readFileSync(p, 'utf8'));
}

for (const { dir, prefix } of extras) {
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) {
        const slug = relative(dir, p).replaceAll('\\', '/').replace(/\.md$/, '');
        const id = `${prefix}/${slug}`;
        const source = readFileSync(p, 'utf8');
        notes.push(noteInfoFromSource(id, source));
        noteText.set(id, source);
      }
    }
  };
  walk(dir);
}

const resolveLink = buildWikilinkResolver({
  notes: () => notes,
  urlFor: (id) => `/${id}/`, // unused by the lint, required by the contract
  locales,
});

/* ---------------- anchor sets (best-effort) ---------------- */

const anchorCache = new Map();
const anchorsOf = (id) => {
  if (anchorCache.has(id)) return anchorCache.get(id);
  const set = new Set();
  const text = noteText.get(id);
  if (text) {
    const masked = maskNonProse(text);
    for (const m of masked.matchAll(/^#{2,4}\s+(.+)$/gm)) {
      let heading = m[1].trim();
      const explicit = /\{#([^}\s]+)[^}]*\}\s*$/.exec(heading);
      if (explicit) {
        set.add(explicit[1]);
        heading = heading.replace(/`?\{[^}]*\}`?\s*$/, '').trim();
      }
      set.add(defaultSlugify(heading.replace(/[*_`]+/g, '')));
    }
  }
  anchorCache.set(id, set);
  return set;
};

/* ---------------- checks ---------------- */

let fails = 0;
let warns = 0;
let total = 0;

for (const n of notes) {
  const text = noteText.get(n.id);
  if (text === undefined) continue;

  if (text.includes('\r')) {
    console.warn(`WARN crlf      ${n.id}: CRLF line endings — frontmatter parsing is LF-only, titles/aliases degrade`);
    warns += 1;
  }

  const links = extractWikilinks(text);
  total += links.length;

  for (const { target, anchor } of links) {
    const res = resolveLink(target, n.id);
    if (res.kind === 'missing') {
      console.error(`FAIL missing   ${n.id}: [[${target}]]`);
      fails += 1;
    } else if (res.kind === 'ambiguous') {
      console.error(`FAIL ambiguous ${n.id}: [[${target}]] → ${res.candidates.join(' / ')}`);
      fails += 1;
    } else if (anchor && !anchorsOf(res.id).has(defaultSlugify(anchor))) {
      console.warn(`WARN anchor    ${n.id}: [[${target}#${anchor}]] (no such heading in ${res.id})`);
      warns += 1;
    }
  }

  // stray unclosed [[ — strip real wikilinks and the [[1]](#ref) citation
  // idiom first, then look for a leftover opener
  const masked = maskNonProse(text);
  WIKILINK_RE.lastIndex = 0;
  const stripped = masked.replace(WIKILINK_RE, '').replace(/\[\[[^\][\n]*\]\]\([^)\n]*\)/g, '');
  const orphan = /(?<!!)\[\[/.exec(stripped);
  if (orphan) {
    const line = stripped.slice(0, orphan.index).split('\n').length;
    console.warn(`WARN unmatched ${n.id}: stray unclosed [[ near line ${line}`);
    warns += 1;
  }
}

console.log(`\nnotes=${notes.length} wikilinks=${total} fails=${fails} warns=${warns}`);
process.exit(strict && fails > 0 ? 1 : 0);
