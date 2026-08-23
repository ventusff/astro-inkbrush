#!/usr/bin/env node
/**
 * check-wikilinks — a [[wikilink]] consistency lint for content repos.
 *
 * The page pipeline never fails a build on a broken wikilink (a miss
 * renders span.wikilink-dead); strict checking is this script's job. It
 * reports:
 *
 *   FAIL missing     the target resolves to no note
 *   FAIL ambiguous   an alias/brand/title matches more than one note
 *   WARN anchor      [[target#heading]] whose heading is not found in the
 *                    target note
 *   WARN unmatched   a stray unclosed `[[` left in prose (typically torn
 *                    apart by a table pipe or a linkReference)
 *   INFO allowed     a missing target the corpus keeps on purpose
 *                    (--allow) — a note demonstrating the dead-link marker
 *
 * The regex, the source masking (the dialect's parser — MDX grammar for
 * .mdx — code, HTML, math, JSX tags and expressions are not prose), the
 * resolver and the note scanner are the package's own wikilinks library —
 * the same code the site's remarkWikilinks runs. What
 * the site injects into that code is reproduced only with --config: its
 * resolver (the note corpus, aliases, locale table, extra corpora) and its
 * anchor slugifier. Without --config, resolution uses the scanned notes
 * (plus --extra corpora) with the locale table from --locale-prefix, and
 * anchors use the library's defaultSlugify — a site that injects its own
 * slugify or a different locale table can differ from this lint exactly
 * there.
 *
 * Anchor checking is best effort: the target note's headings are read by
 * parsing its masked source with the dialect, their text is slugged with
 * the anchor slugifier, duplicate slugs take `-2`, `-3`, … suffixes and an
 * explicit `{#id}` wins — the model most site sluggers implement. It
 * matches the site's real ids only as far as --config injects the site's
 * own slugifier; a site with different dedup or numbering rules can still
 * diverge, which is why an anchor miss is a WARN, never a FAIL.
 *
 * Usage (from the site or content repo root):
 *   node <engine>/scripts/check-wikilinks.mjs <content-dir> [flags]
 *
 *   --strict                 exit 1 when the report carries any FAIL (dead
 *                            link: missing or ambiguous); WARNs never affect
 *                            the exit code. Without --strict the exit code
 *                            is 0 and dead links are only listed.
 *   --locale-prefix <p/>     locale-mirror prefix (repeatable; replaces the
 *                            default `en/ de/` set when given) — a link
 *                            inside a mirrored note resolves to its own
 *                            locale's mirror first
 *   --extra <dir>:<prefix>   an extra flat corpus of `*.md` files whose ids
 *                            are `<prefix>/<relative-path-minus-.md>`
 *                            (repeatable) — e.g. a card vault:
 *                            --extra src/content/vault/cards:cards
 *   --config <path>          a JS/TS module exporting `wikilinks`: the
 *                            options object the site passes to
 *                            remarkWikilinks ({ resolve, slugifyAnchor,
 *                            noteIdOf }). Its resolver and slugifier replace
 *                            the built-in ones; --locale-prefix and --extra
 *                            are then not accepted. Loaded with Node's
 *                            native TypeScript support.
 *   --allow <target>         a link target that may resolve to nothing
 *                            (repeatable); reported as INFO, never a FAIL
 *   --allow-empty            accept a corpus with zero notes (without it, an
 *                            empty corpus is a failure — it certifies
 *                            nothing)
 *   --help                   print this usage
 *
 * Exit code: 0 clean (or FAILs without --strict), 1 FAILs under --strict —
 * a nonexistent content dir and an empty corpus without --allow-empty are
 * failures regardless of --strict — 2 usage error.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import remarkParse from 'remark-parse';
import { unified } from 'unified';

const engineRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const { buildWikilinkResolver, defaultSlugify, extractWikilinks, maskNonProse, noteInfoFromSource, scanNotes } =
  await import(pathToFileURL(join(engineRoot, 'src/lib/wikilinks.ts')).href);
const { markdownSyntax } = await import(pathToFileURL(join(engineRoot, 'src/lib/markdown-syntax.ts')).href);

/* ---------------- site config ---------------- */

/** Load the site's `wikilinks` export (named, or a property of the default export): the remarkWikilinks options object */
export async function loadSiteConfig(path) {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const cfg = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const wikilinks = cfg.wikilinks;
  if (!wikilinks || typeof wikilinks.resolve !== 'function') {
    throw new Error(`${path}: export "wikilinks" must be the remarkWikilinks options object ({ resolve, slugifyAnchor?, noteIdOf? })`);
  }
  return wikilinks;
}

/* ---------------- corpus ---------------- */

/** the source path of a standard-layout note, or null */
function pathOfNote(root, id) {
  for (const ext of ['mdx', 'md']) {
    const p = join(root, id, `index.${ext}`);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

/**
 * An extra flat corpus: every `*.md` under `dir` (dot- and
 * underscore-prefixed entries skipped) as `<prefix>/<slug>`. Symlinks are
 * followed only while their real path stays inside the corpus root's real
 * path, and each real directory is visited once — a symlink cycle cannot
 * recurse and a link out of the tree is not scanned.
 */
function* extraCorpus(dir, prefix) {
  let rootReal;
  try {
    rootReal = realpathSync(dir);
  } catch {
    return;
  }
  const insideRoot = (real) => real === rootReal || real.startsWith(rootReal + sep);
  const visited = new Set([rootReal]);
  const walk = function* (d, realDir) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const p = join(d, name);
      let real = join(realDir, name);
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
        if (!insideRoot(real)) continue;
      }
      if (isDirectory) {
        if (visited.has(real)) continue;
        visited.add(real);
        yield* walk(p, real);
      } else if (isFile && name.endsWith('.md')) {
        const slug = relative(dir, p).replaceAll('\\', '/').replace(/\.md$/, '');
        yield { id: `${prefix}/${slug}`, path: p };
      }
    }
  };
  yield* walk(dir, rootReal);
}

/**
 * Collect the notes to lint: the standard-layout corpus under `root` plus
 * any extra corpora. Each entry carries its id, source path and text.
 */
export function collectCorpus(root, extras = []) {
  const corpus = [];
  for (const note of scanNotes(root)) {
    const path = pathOfNote(root, note.id);
    if (path) corpus.push({ ...note, path, text: readFileSync(path, 'utf8') });
  }
  for (const { dir, prefix } of extras) {
    for (const { id, path } of extraCorpus(dir, prefix)) {
      const text = readFileSync(path, 'utf8');
      corpus.push({ ...noteInfoFromSource(id, text), path, text });
    }
  }
  return corpus;
}

/* ---------------- anchors (best effort) ---------------- */

/** the dialect's parser, for heading extraction over masked sources */
const headingParser = unified().use(remarkParse).use(markdownSyntax()).freeze();

/** the concatenated literal text of a node's subtree (text and inlineCode values) */
function literalText(node) {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(literalText).join('');
}

/**
 * Ids a [[note#anchor]] can target, best effort. The masked source is
 * parsed with the dialect, so ATX and setext headings count and anything in
 * code, HTML or math does not. Each heading contributes:
 *
 *  - its explicit `{#id}` when the text carries one (used as spelled, and
 *    occupying its slug in the dedup pool the way site sluggers reserve
 *    explicit ids);
 *  - the slug of its text, deduplicated with `-2`, `-3`, … suffixes when an
 *    earlier heading generates the same slug. A heading with an explicit id
 *    also contributes its text slug (without a dedup slot) so a site whose
 *    slugger keeps both spellings does not warn.
 */
export function anchorsOf(text, slugify, mask = {}) {
  const set = new Set();
  const used = new Set();
  const tree = headingParser.parse(maskNonProse(text, mask));
  const walk = (node) => {
    if (node.type === 'heading') {
      let heading = literalText(node).replace(/\s+/g, ' ').trim();
      const explicit = /\{#([^}\s]+)[^}]*\}\s*$/.exec(heading);
      if (explicit) {
        heading = heading.replace(/\{[^}]*\}\s*$/, '').trim();
        set.add(explicit[1]);
        used.add(explicit[1]);
        set.add(slugify(heading));
        return;
      }
      const base = slugify(heading);
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      set.add(id);
      return;
    }
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
  return set;
}

/* ---------------- the lint ---------------- */

/**
 * Lint a corpus. `options.site` is the site's remarkWikilinks options
 * object (its resolver and slugifier win); otherwise `options.locales` and
 * `options.extras` configure the built-in resolver. `options.allow` lists
 * targets that may resolve to nothing. Returns counts and the report lines
 * in discovery order.
 */
export function checkWikilinks(root, options = {}) {
  const corpus = collectCorpus(root, options.extras ?? []);
  const site = options.site;
  const allow = new Set(options.allow ?? []);
  const resolveLink =
    site?.resolve ??
    buildWikilinkResolver({
      notes: () => corpus,
      urlFor: (id) => `/${id}/`,
      locales: options.locales,
    });
  const slugify = site?.slugifyAnchor ?? defaultSlugify;
  const byId = new Map(corpus.map((n) => [n.id, n]));
  const maskOptions = (n) => ({ mdx: n.path.endsWith('.mdx') });
  const anchorCache = new Map();
  const anchorsIn = (id) => {
    let set = anchorCache.get(id);
    if (!set) {
      const target = byId.get(id);
      set = target === undefined ? null : anchorsOf(target.text, slugify, maskOptions(target));
      anchorCache.set(id, set);
    }
    return set;
  };

  const report = [];
  let fails = 0;
  let warns = 0;
  let wikilinks = 0;
  const fail = (kind, note, message) => {
    fails += 1;
    report.push({ level: 'FAIL', kind, note, message });
  };
  const warn = (kind, note, message) => {
    warns += 1;
    report.push({ level: 'WARN', kind, note, message });
  };
  const info = (kind, note, message) => {
    report.push({ level: 'INFO', kind, note, message });
  };

  for (const n of corpus) {
    const fromId = site?.noteIdOf?.(n.path) ?? n.id;
    const links = extractWikilinks(n.text, maskOptions(n));
    wikilinks += links.length;

    for (const { target, anchor } of links) {
      const res = resolveLink(target, fromId);
      if (res.kind === 'missing') {
        if (allow.has(target)) info('allowed', n.id, `[[${target}]]`);
        else fail('missing', n.id, `[[${target}]]`);
      } else if (res.kind === 'ambiguous') {
        fail('ambiguous', n.id, `[[${target}]] → ${res.candidates.join(' / ')}`);
      } else if (anchor) {
        const anchors = anchorsIn(res.id);
        if (anchors && !anchors.has(slugify(anchor))) {
          warn('anchor', n.id, `[[${target}#${anchor}]] (no such heading in ${res.id})`);
        }
      }
    }

    // a stray unclosed [[: blank the rendered wikilinks and the [[1]](#ref)
    // citation idiom out of the prose, then look for a leftover opener —
    // one that is not itself backslash-escaped (`\[[` is literal text)
    const prose = maskNonProse(n.text, maskOptions(n)).split('');
    for (const { offset, raw } of links) prose.fill(' ', offset, offset + raw.length);
    const stripped = prose.join('').replace(/\[\[[^\][\n]*\]\]\([^)\n]*\)/g, (m) => ' '.repeat(m.length));
    for (const orphan of stripped.matchAll(/(?<!!)\[\[/g)) {
      let backslashes = 0;
      for (let i = orphan.index - 1; i >= 0 && stripped[i] === '\\'; i -= 1) backslashes += 1;
      if (backslashes % 2 === 1) continue;
      const line = stripped.slice(0, orphan.index).split('\n').length;
      warn('unmatched', n.id, `stray unclosed [[ near line ${line}`);
      break;
    }
  }

  return { notes: corpus.length, wikilinks, fails, warns, report };
}

/* ---------------- CLI ---------------- */

const USAGE = `usage: check-wikilinks.mjs <content-dir> [--strict] [--locale-prefix <p/>]... [--extra <dir>:<idPrefix>]... [--config <path>] [--allow <target>]... [--allow-empty]

  <content-dir>            the notes root (<id>/index.{md,mdx} layout)
  --strict                 exit 1 when the report carries any FAIL (dead
                           link: missing or ambiguous target); WARNs never
                           affect the exit code. Without --strict dead links
                           are listed and the exit code is 0.
  --locale-prefix <p/>     locale-mirror prefix (repeatable; replaces the
                           default en/ de/ set)
  --extra <dir>:<prefix>   an extra flat corpus of *.md files with ids
                           <prefix>/<relative-path-minus-.md> (repeatable)
  --config <path>          JS/TS module exporting \`wikilinks\`: the options
                           object the site passes to remarkWikilinks
                           ({ resolve, slugifyAnchor, noteIdOf }); its
                           resolver and slugifier replace the built-in ones,
                           and --locale-prefix / --extra are not accepted
  --allow <target>         a link target that may resolve to nothing
                           (repeatable) — reported as INFO, never a FAIL
  --allow-empty            accept a corpus with zero notes (without it, an
                           empty corpus fails — it certifies nothing)
  --help                   print this usage

Reports FAIL missing / FAIL ambiguous (dead links), WARN anchor (no such
heading in the target, best effort), WARN unmatched (stray unclosed [[),
INFO allowed (a --allow target that resolves to nothing).
The regex, masking, resolver and scanner are the package's own wikilinks
library; the site's injected resolver and slugifier are used only with
--config.`;

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const valued = new Set(['--locale-prefix', '--extra', '--config', '--allow']);
  const flags = new Set(['--strict', '--allow-empty']);
  if (valued.has(argv[argv.length - 1])) {
    console.error(`${argv[argv.length - 1]} requires a value\n\n${USAGE}`);
    return 2;
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const unknown = argv.filter((a) => a.startsWith('--') && !valued.has(a) && !flags.has(a));
  if (positional.length !== 1 || unknown.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const many = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const strict = argv.includes('--strict');
  const allowEmpty = argv.includes('--allow-empty');
  const localePrefixes = many('locale-prefix');
  const extraSpecs = many('extra');
  const configPath = many('config')[0];
  const allow = many('allow');

  let site;
  if (configPath !== undefined) {
    if (localePrefixes.length > 0 || extraSpecs.length > 0) {
      console.error('--config supplies the site resolver; --locale-prefix and --extra are not accepted with it');
      return 2;
    }
    try {
      site = await loadSiteConfig(configPath);
    } catch (err) {
      console.error(`cannot load --config ${configPath}: ${err.message}`);
      return 2;
    }
  }

  const locales = (localePrefixes.length > 0 ? localePrefixes : ['en/', 'de/']).map((prefix) => ({
    code: prefix.replace(/\/+$/, ''),
    prefix,
  }));
  const extras = [];
  for (const spec of extraSpecs) {
    const idx = spec.lastIndexOf(':');
    if (idx <= 0) {
      console.error(`--extra expects <dir>:<idPrefix>, got: ${spec}`);
      return 2;
    }
    extras.push({ dir: resolve(spec.slice(0, idx)), prefix: spec.slice(idx + 1).replace(/\/+$/, '') });
  }

  const root = resolve(positional[0]);
  let rootStat = null;
  try {
    rootStat = statSync(root);
  } catch {
    /* reported below */
  }
  if (rootStat === null || !rootStat.isDirectory()) {
    console.error(`✗ content dir does not exist or is not a directory: ${root}`);
    return 1;
  }

  const result = checkWikilinks(root, { locales, extras, site, allow });
  for (const { level, kind, note, message } of result.report) {
    const line = `${level} ${kind.padEnd(9)} ${note}: ${message}`;
    if (level === 'FAIL') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }
  console.log(`\nnotes=${result.notes} wikilinks=${result.wikilinks} fails=${result.fails} warns=${result.warns}`);
  if (result.notes === 0 && !allowEmpty) {
    console.error(`✗ no notes found under ${root} — an empty corpus certifies nothing (pass --allow-empty when that is intended)`);
    return 1;
  }
  return strict && result.fails > 0 ? 1 : 0;
}

function isEntry() {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntry()) process.exit(await main(process.argv.slice(2)));
