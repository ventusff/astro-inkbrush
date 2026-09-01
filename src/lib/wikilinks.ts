/**
 * wikilinks — THE [[wikilink]] implementation (subpath export
 * astro-inkbrush/wikilinks): the grammar, resolver and remark transform of
 * ./wikilink-core.ts (re-exported), plus the parts that need Node or a whole-
 * document parser — the content-directory scanner and the source-level
 * extractor (backlink indexes, the Obsidian importer, lint). Shared by all
 * three consumers — the site's rendering pipeline, the in-package preview
 * pipeline (server/markdown.ts), and the Obsidian importer — so parsing can
 * never drift. Composition belongs to the caller: the site injects its own
 * noteUrl/slugify/onBroken.
 *
 * Browser code imports ./wikilink-core.ts (or astro-inkbrush/wikilinks/core)
 * directly: this module carries node:fs and the MDX grammar.
 *
 * The extractor sees the raw source and checks backslash parity directly
 * (an odd run of `\` before `[[` escapes it).
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { splitFrontmatter } from './frontmatter.ts';
import { markdownSyntax } from './markdown-syntax.ts';
import { WIKILINK_RE, type WikiNoteInfo } from './wikilink-core.ts';

export * from './wikilink-core.ts';

/* ---------------- frontmatter ---------------- */

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
  const fm = splitFrontmatter(source).data;
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
  /** leave `$…$` / `$$…$$` spans as prose — for tools that rewrite math syntax */
  keepMath?: boolean | undefined;
}

/** the dialect's parser plus math — parse only, no transforms; built on
 *  first use and reused across calls */
interface Parser {
  parse(text: string): unknown;
}
let parsers: { md: Parser; mdx: Parser } | null = null;
function parserFor(mdx: boolean): Parser {
  const built = (parsers ??= {
    md: unified().use(remarkParse).use(markdownSyntax()).use(remarkMath).freeze(),
    mdx: unified().use(remarkParse).use(markdownSyntax()).use(remarkMath).use(remarkMdx).freeze(),
  });
  return mdx ? built.mdx : built.md;
}

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
  const fm = splitFrontmatter(source);
  if (fm.present) blankRange(chars, fm.start, fm.end);
  const text = chars.join('');
  let tree: PositionedNode;
  try {
    tree = parserFor(options.mdx === true).parse(text) as unknown as PositionedNode;
  } catch {
    tree = parserFor(false).parse(text) as unknown as PositionedNode;
  }
  const walk = (node: PositionedNode): void => {
    const range = offsetsOf(node);
    if (MASKED_TYPES.has(node.type)) {
      const kept = options.keepMath === true && (node.type === 'math' || node.type === 'inlineMath');
      if (range && !kept) blankRange(chars, range[0], range[1]);
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
 * tags are blanked and their children stay prose. With `keepMath: true`
 * math spans stay prose (code and HTML remain blanked). MDX that does not
 * parse falls back to the CommonMark reading; masking never throws.
 */
export function maskNonProse(source: string, options: MaskOptions = {}): string {
  return proseOf(source, options).masked;
}

/** an odd run of `\` immediately before `index` escapes the character there */
function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
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
    // `\[[` is an escaped bracket, not a wikilink opener
    if (escapedAt(masked, start)) continue;
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
