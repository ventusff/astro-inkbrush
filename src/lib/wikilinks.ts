/**
 * wikilinks — THE [[wikilink]] implementation (subpath export
 * astro-inkbrush/wikilinks).
 *
 * Pipeline-agnostic transform factory + resolver + fs scanner, shared by all
 * three consumers — the site's rendering pipeline, the in-package preview
 * pipeline (server/markdown.ts), and the Obsidian importer — so parsing can
 * never drift. Composition belongs to the caller: the site injects its own
 * noteUrl/slugify/onBroken. The module depends only on the package's own
 * Markdown dialect, remark-parse/remark-math/remark-mdx (source masking)
 * and `yaml` (frontmatter).
 *
 * Syntax: [[target]] · [[target|label]] · [[target#anchor]] (![[embed]] is
 * handled elsewhere).
 * Resolution order: source note's locale mirror → exact id → alias → brand →
 * title (case-insensitive).
 * A miss never fails the build: it renders span.wikilink-dead and fires
 * onBroken; strict checking belongs to lint.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parseDocument } from 'yaml';

import { markdownSyntax } from './markdown-syntax.ts';

/** shared regex; capture groups: 1=target 2=anchor? 3=label?
 *  (?<!!) excludes ![[embed]]; (?!\() excludes [[1]](#ref)-style markdown
 *  link text (the citation-footnote idiom — [[x]](y) is always a markdown
 *  link, never a wikilink) */
export const WIKILINK_RE = /(?<!!)\[\[([^\][|#\n]+)(?:#([^\][|\n]*))?(?:\|([^\][\n]+))?\]\](?!\()/g;

export interface WikiNoteInfo {
  id: string;
  title: string;
  brand?: string | undefined;
  aliases: string[];
}

export type WikilinkResolution =
  | { kind: 'ok'; id: string; url: string; title: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] };

export type WikilinkResolver = (target: string, fromNoteId?: string) => WikilinkResolution;

// the uninjected fallback locale table; the registry of record is
// src/wiki/shared/locales.ts — the two must agree
const DEFAULT_LOCALES = [
  { code: 'en', prefix: 'en/' },
  { code: 'de', prefix: 'de/' },
];

/** default anchor slugifier, matching the usual heading-slug plugin rules
 *  (e.g. astro-inkstone's); sites should inject their own explicitly */
export function defaultSlugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[\s·/]+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/* ---------------- resolver ---------------- */

interface ResolverMaps {
  byId: Map<string, WikiNoteInfo>;
  byKey: Map<string, string[]>; // normalized alias/brand/title → note ids
}

export function buildWikilinkResolver(opts: {
  /** the note list (caching is the caller's business — builds pass a one-shot
   *  array, dev passes cachedScan) */
  notes: () => WikiNoteInfo[];
  /** id → site URL (sites pass their noteUrl; previews pass (id) => `/${id}/`) */
  urlFor: (id: string) => string;
  locales?: { code: string; prefix: string }[];
}): WikilinkResolver {
  const locales = opts.locales ?? DEFAULT_LOCALES;
  let lastNotes: WikiNoteInfo[] | null = null;
  let maps: ResolverMaps | null = null;

  const norm = (s: string): string => s.trim().toLowerCase();

  const mapsFor = (notes: WikiNoteInfo[]): ResolverMaps => {
    if (maps && lastNotes === notes) return maps;
    const byId = new Map<string, WikiNoteInfo>();
    const byKey = new Map<string, string[]>();
    const add = (key: string, id: string): void => {
      const k = norm(key);
      if (!k) return;
      const list = byKey.get(k) ?? [];
      if (!list.includes(id)) list.push(id);
      byKey.set(k, list);
    };
    for (const n of notes) {
      byId.set(n.id, n);
      for (const a of n.aliases) add(a, n.id);
      if (n.brand) add(n.brand, n.id);
      add(n.title, n.id);
    }
    lastNotes = notes;
    maps = { byId, byKey };
    return maps;
  };

  return (target, fromNoteId) => {
    const { byId, byKey } = mapsFor(opts.notes());
    const t = target.trim();

    const ok = (id: string): WikilinkResolution => {
      const note = byId.get(id);
      return { kind: 'ok', id, url: opts.urlFor(id), title: note?.title ?? id };
    };

    // 1) the source note's locale mirror wins ([[X]] inside an en note → en/X
    //    when it exists); the default locale's empty prefix names no mirror
    const fromPrefix = locales.find((l) => l.prefix !== '' && fromNoteId?.startsWith(l.prefix))?.prefix ?? '';
    if (fromPrefix && byId.has(`${fromPrefix}${t}`)) return ok(`${fromPrefix}${t}`);
    // 2) exact id (including explicit en/-prefixed spellings)
    if (byId.has(t)) return ok(t);
    // 3) alias / brand / title (case-insensitive; multiple hits = ambiguous)
    const hits = byKey.get(norm(t));
    if (hits && hits.length === 1) return ok(hits[0]!);
    if (hits && hits.length > 1) return { kind: 'ambiguous', candidates: hits };
    return { kind: 'missing' };
  };
}

/* ---------------- remark transform ---------------- */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const NO_DESCEND = new Set(['link', 'linkReference', 'code', 'inlineCode', 'math', 'inlineMath']);

export interface BrokenWikilink {
  file?: string | undefined;
  target: string;
  kind: 'missing' | 'ambiguous';
}

export function remarkWikilinks(opts: {
  resolve: WikilinkResolver;
  slugifyAnchor?: (raw: string) => string;
  /** derive the source note id from the compiled file path (for locale-aware resolution) */
  noteIdOf?: (filePath: string | undefined) => string | undefined;
  onBroken?: (b: BrokenWikilink) => void;
}) {
  const slug = opts.slugifyAnchor ?? defaultSlugify;

  return (tree: MdNode, file?: { path?: string }): void => {
    const fromId = opts.noteIdOf?.(file?.path);

    const transformText = (node: MdNode): MdNode[] | null => {
      const value = node.value ?? '';
      WIKILINK_RE.lastIndex = 0;
      if (!WIKILINK_RE.test(value)) return null;
      WIKILINK_RE.lastIndex = 0;

      const out: MdNode[] = [];
      let last = 0;
      for (const m of value.matchAll(WIKILINK_RE)) {
        const [raw, target, anchor, label] = m as unknown as [
          string,
          string,
          string | undefined,
          string | undefined,
        ];
        const idx = m.index ?? 0;
        if (idx > last) out.push({ type: 'text', value: value.slice(last, idx) });
        last = idx + raw.length;

        const shown = (label ?? (anchor ? `${target}#${anchor}` : target)).trim();
        const res = opts.resolve(target, fromId);
        if (res.kind === 'ok') {
          out.push({
            type: 'link',
            url: anchor ? `${res.url}#${slug(anchor)}` : res.url,
            title: res.title,
            data: { hProperties: { className: ['wikilink'], 'data-note': res.id } },
            children: [{ type: 'text', value: shown }],
          });
        } else {
          const tip =
            res.kind === 'ambiguous'
              ? `ambiguous target: ${res.candidates.join(' / ')}`
              : `no such note: ${target.trim()}`;
          out.push({
            type: 'wikilinkDead',
            data: {
              hName: 'span',
              hProperties: { className: ['wikilink', 'wikilink-dead'], title: tip },
            },
            children: [{ type: 'text', value: shown }],
          });
          opts.onBroken?.({ file: file?.path, target: target.trim(), kind: res.kind });
        }
      }
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
      return out;
    };

    const walk = (node: MdNode): void => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]!;
        if (NO_DESCEND.has(child.type)) continue;
        if (child.type === 'text') {
          const replaced = transformText(child);
          if (replaced) {
            children.splice(i, 1, ...replaced);
            i += replaced.length - 1;
          }
          continue;
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/* ---------------- frontmatter ---------------- */

/** the frontmatter block Astro recognises: an optional BOM or leading blank
 *  lines, then `---` … `---` (LF or CRLF); group 1 is the YAML body */
const FRONTMATTER_RE = /(?:^\uFEFF?|^\s*\n)---([\s\S]*?\n)---/;

/** YAML frontmatter → plain object. Absent, non-mapping or malformed YAML
 *  yields `{}`; the site build reports YAML errors itself. */
function frontmatterOf(source: string): Record<string, unknown> {
  const raw = FRONTMATTER_RE.exec(source)?.[1];
  if (raw === undefined) return {};
  const doc = parseDocument(raw, { logLevel: 'silent' });
  if (doc.errors.length > 0) return {};
  const value: unknown = doc.toJS();
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** a YAML scalar as a non-empty trimmed string; anything else is absent */
function fmScalar(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s || undefined;
}

/** a YAML sequence of scalars (non-scalar items dropped); a lone scalar is a one-item list */
function fmStringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(fmScalar).filter((s): s is string => s !== undefined);
}

/** parse one source string's frontmatter into a WikiNoteInfo (title falls
 *  back to the id) — for corpora that don't follow the index.md layout,
 *  e.g. flat card files fed to the lint CLI via --extra */
export function noteInfoFromSource(id: string, source: string): WikiNoteInfo {
  const fm = frontmatterOf(source);
  return {
    id,
    title: fmScalar(fm['title']) ?? id,
    brand: fmScalar(fm['brand']),
    aliases: fmStringList(fm['aliases']),
  };
}

/* ---------------- fs scan ---------------- */

const NOTE_FILES = new Set(['index.md', 'index.mdx']);

/**
 * scan <contentDir>/**\/index.{mdx,md} → WikiNoteInfo[]; `_meta`, `docs` and
 * dot-prefixed entries are not notes. Symlinks are followed only while their
 * real path stays inside the content root, and each real directory is
 * scanned once, under the first path that reaches it in name order (a
 * symlink cycle cannot recurse). A directory holding both index.md and
 * index.mdx is one note id with two sources: that throws.
 */
export function scanNotes(contentDir: string): WikiNoteInfo[] {
  const notes: WikiNoteInfo[] = [];
  let root: string;
  try {
    root = realpathSync(contentDir);
  } catch {
    return notes;
  }
  const insideRoot = (real: string): boolean => real === root || real.startsWith(root + sep);
  const visited = new Set<string>([root]);

  const walk = (dir: string, realDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    const indexFiles: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name === '_meta' || name === 'docs' || name.startsWith('.')) continue;
      const p = join(dir, name);
      let real = join(realDir, name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          real = realpathSync(p);
          isDirectory = statSync(real).isDirectory();
        } catch {
          continue;
        }
        if (!insideRoot(real)) continue;
      }
      if (isDirectory) {
        if (visited.has(real)) continue;
        visited.add(real);
        walk(p, real);
      } else if (NOTE_FILES.has(name)) {
        indexFiles.push(name);
      }
    }
    if (indexFiles.length > 1) {
      throw new Error(
        `${dir}: both index.md and index.mdx exist — one note id ("${relative(contentDir, dir).replaceAll('\\', '/') || '/'}") cannot have two sources; keep one file`,
      );
    }
    const id = relative(contentDir, dir).replaceAll('\\', '/');
    if (indexFiles.length === 1 && id) {
      notes.push(noteInfoFromSource(id, readFileSync(join(dir, indexFiles[0]!), 'utf8')));
    }
  };
  walk(contentDir, root);
  return notes;
}

/** TTL-memoized scanNotes (dev picks up new notes; builds amortize to one scan) */
export function cachedScan(contentDir: string, ttlMs = 2000): () => WikiNoteInfo[] {
  let at = 0;
  let cache: WikiNoteInfo[] | null = null;
  return () => {
    const now = Date.now();
    if (!cache || now - at > ttlMs) {
      cache = scanNotes(contentDir);
      at = now;
    }
    return cache;
  };
}

/* ---------------- source-level extraction (backlink indexes / importer / lint) ---------------- */

export interface ExtractedWikilink {
  target: string;
  anchor?: string | undefined;
  label?: string | undefined;
  /** offset into the pre-mask original (masking replaces at equal length, so offsets stay valid) */
  offset: number;
  raw: string;
}

/** node types whose source range is never prose for the wikilink transform:
 *  it does not descend into links and images, and code, HTML, math, MDX
 *  ESM and expressions have no prose inside */
const MASKED_TYPES = new Set([
  'code',
  'inlineCode',
  'html',
  'math',
  'inlineMath',
  'link',
  'linkReference',
  'definition',
  'image',
  'imageReference',
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxTextExpression',
]);

/** JSX elements: the tags (with their attributes) are not prose, the children are */
const JSX_TYPES = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement']);

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } };
  children?: PositionedNode[];
}

export interface MaskOptions {
  /** parse with the MDX grammar (JSX, expressions, ESM) — pass true for .mdx sources */
  mdx?: boolean | undefined;
}

/** the dialect's parser plus math — parse only, no transforms, reused across calls */
const mdParser = unified().use(remarkParse).use(markdownSyntax()).use(remarkMath).freeze();
const mdxParser = unified().use(remarkParse).use(markdownSyntax()).use(remarkMath).use(remarkMdx).freeze();

/** replace every character of `text` in [start, end) with a space, keeping line breaks */
function blankRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i += 1) {
    const c = chars[i]!;
    if (c !== '\n' && c !== '\r') chars[i] = ' ';
  }
}

function offsetsOf(node: PositionedNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? [start, end] : null;
}

/**
 * The prose view of a source: the masked text, and the offsets where prose
 * is cut by a table-cell boundary (a `[[…]]` spanning two cells is two
 * fragments of text to the parser, never one wikilink).
 */
function proseOf(source: string, options: MaskOptions): { masked: string; cuts: number[] } {
  const chars = source.split('');
  const cuts: number[] = [];
  const fm = FRONTMATTER_RE.exec(source);
  if (fm) blankRange(chars, fm.index, fm.index + fm[0].length);
  const text = chars.join('');
  let tree: PositionedNode;
  try {
    tree = (options.mdx ? mdxParser : mdParser).parse(text) as unknown as PositionedNode;
  } catch {
    tree = mdParser.parse(text) as unknown as PositionedNode;
  }
  const walk = (node: PositionedNode): void => {
    const range = offsetsOf(node);
    if (MASKED_TYPES.has(node.type)) {
      if (range) blankRange(chars, range[0], range[1]);
      return;
    }
    const children = node.children ?? [];
    if (JSX_TYPES.has(node.type) && range) {
      const first = children[0] && offsetsOf(children[0]);
      const last = children[children.length - 1] && offsetsOf(children[children.length - 1]!);
      if (first && last) {
        blankRange(chars, range[0], first[0]);
        blankRange(chars, last[1], range[1]);
      } else {
        blankRange(chars, range[0], range[1]);
      }
    }
    if (node.type === 'tableRow') {
      for (let i = 1; i < children.length; i += 1) {
        const prev = offsetsOf(children[i - 1]!);
        if (prev) cuts.push(prev[1]);
      }
    }
    children.forEach(walk);
  };
  walk(tree);
  return { masked: chars.join(''), cuts };
}

/**
 * Blank out everything that is not prose at equal length (offsets unchanged):
 * the frontmatter block, then every node the dialect's parser produces that
 * the wikilink transform never enters — fenced (backtick or tilde) and
 * indented code blocks, multi-backtick code spans, HTML blocks and inline
 * tags, `$…$` / `$$…$$` math, links, images and definitions. With
 * `mdx: true` the MDX grammar applies: ESM and expressions are blanked, JSX
 * tags are blanked and their children stay prose. MDX that does not parse
 * falls back to the CommonMark reading; masking never throws.
 */
export function maskNonProse(source: string, options: MaskOptions = {}): string {
  return proseOf(source, options).masked;
}

/** the wikilinks the page pipeline would render from `source`, with their source offsets */
export function extractWikilinks(source: string, options: MaskOptions = {}): ExtractedWikilink[] {
  const { masked, cuts } = proseOf(source, options);
  const out: ExtractedWikilink[] = [];
  WIKILINK_RE.lastIndex = 0;
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0]!.length;
    if (cuts.some((c) => c > start && c < end)) continue;
    out.push({
      target: m[1]!.trim(),
      anchor: m[2]?.trim(),
      label: m[3]?.trim(),
      offset: m.index ?? 0,
      raw: m[0]!,
    });
  }
  return out;
}
