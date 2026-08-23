/**
 * rehype-wiki-blocks — WIKI mode only (never part of the static build).
 *
 * Stamps every top-level block of a note with its source line range so the
 * wiki client can offer in-place editing:
 *
 *  - markdown-derived elements get `data-wiki-src="start-end"` directly;
 *  - JSX components can't receive extra attributes (Astro components don't
 *    spread unknown props), so an invisible `<template data-wiki-src …>`
 *    anchor is inserted BEFORE them and the client binds it to its next
 *    element sibling. `<template>` renders nothing and is layout-inert —
 *    the one thing that could notice it is a CSS adjacency selector
 *    (`X + Y`) between top-level blocks, which sites should avoid in
 *    WIKI mode.
 *  - the frontmatter is rendered by the site's layout (title, description,
 *    taxonomy), never by this pipeline, so it gets a `<template
 *    data-wiki-src="1-N" data-wiki-frontmatter>` anchor as the first child
 *    of the body; the client binds it to the site's
 *    `[data-inkbrush-slot="frontmatter"]` element (the page head or meta
 *    strip). Emitted only when the processed value is the note file itself
 *    (or its body), read from disk — a fragment render has no frontmatter
 *    of its own.
 *
 * Position fallbacks (in order): the node's own position → first/last
 * positioned descendant (e.g. div.tbl-wrap wrappers) → the gap between the
 * neighbouring positioned siblings (e.g. KaTeX display blocks, whose nodes
 * carry no position), trimmed to non-empty source lines.
 */
import type { Root } from 'hast';
import type { VFile } from 'vfile';

import { splitFrontmatter } from './frontmatter.ts';


interface Pos {
  start: number;
  end: number;
}

type AnyNode = {
  type: string;
  name?: string;
  tagName?: string;
  children?: AnyNode[];
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
} & Record<string, unknown>;

function ownPos(node: AnyNode): Pos | null {
  return node.position ? { start: node.position.start.line, end: node.position.end.line } : null;
}

/** deep search: range spanned by the first and last positioned descendants */
function descendantPos(node: AnyNode): Pos | null {
  let first: number | null = null;
  let last: number | null = null;
  const walk = (n: AnyNode): void => {
    const p = ownPos(n);
    if (p) {
      first = first === null ? p.start : Math.min(first, p.start);
      last = last === null ? p.end : Math.max(last, p.end);
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return first !== null && last !== null ? { start: first, end: last } : null;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === '';
}

/**
 * The raw file behind the vfile, null when unreadable. fs is reached through
 * `process.getBuiltinModule`, never an import: the module also runs in
 * browser bundles (the playground renders patched fragments with it), where
 * there is no `process` and no file behind the vfile; and under Vite a
 * workspace-linked copy of this package is evaluated by the module runner,
 * whose dynamic `import()` is dead once config loading has finished while the
 * pipeline keeps running.
 */
function readRaw(path: string): string | null {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process?.getBuiltinModule;
  if (typeof getBuiltin !== 'function') return null;
  try {
    const fs = getBuiltin('node:fs') as typeof import('node:fs');
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function rehypeWikiBlocks() {
  return (tree: Root, file: VFile): void => {
    const children = tree.children as unknown as AnyNode[];

    // Stamps must be RAW file lines — the server reads and writes blocks by
    // them. Positions are relative to the vfile value the pipeline parsed,
    // and pipelines differ in what that is: the raw file, the raw file with
    // the frontmatter blanked line-for-line (MDX), the body alone with its
    // leading and trailing blank lines trimmed (Astro's .md content entries),
    // or no value at all. The offset is therefore MEASURED against the file
    // on disk: same line count → none; otherwise the value is located inside
    // the raw text and the lines before it are the offset (a line-count
    // difference would miscount the trimmed tail). Zero when the raw file is
    // unreadable — the browser playground renders fragments with no file
    // behind them.
    let offset = 0;
    let value = typeof file.value === 'string' ? file.value : '';
    const raw = file.path ? readRaw(file.path) : null;
    /** the value is the file, or the file's body (its tail modulo blanks) */
    let wholeNote = false;
    if (raw !== null) {
      if (value === '') {
        value = raw;
        wholeNote = true;
      } else if (raw.split('\n').length === value.split('\n').length) {
        wholeNote = true;
      } else {
        const at = raw.indexOf(value);
        if (at >= 0) {
          offset = raw.slice(0, at).split('\n').length - 1;
          wholeNote = raw.slice(at + value.length).trim() === '';
        } else {
          const delta = raw.split('\n').length - value.split('\n').length;
          if (delta > 0) offset = delta;
        }
      }
    }
    const sourceLines = value.split('\n');

    // pass 1: resolve a position for every stampable top-level node
    const resolved: (Pos | null)[] = children.map((node) => {
      if (node.type !== 'element' && node.type !== 'mdxJsxFlowElement') return null;
      return ownPos(node) ?? descendantPos(node);
    });

    // pass 2: gap-fill nodes that still have no position from their neighbours
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!;
      if (resolved[i] || (node.type !== 'element' && node.type !== 'mdxJsxFlowElement')) continue;
      let prevEnd = 0;
      for (let j = i - 1; j >= 0; j--) {
        const p = resolved[j] ?? ownPos(children[j]!);
        if (p) {
          prevEnd = p.end;
          break;
        }
      }
      let nextStart = sourceLines.length + 1;
      for (let j = i + 1; j < children.length; j++) {
        const p = resolved[j] ?? ownPos(children[j]!);
        if (p) {
          nextStart = p.start;
          break;
        }
      }
      let start = prevEnd + 1;
      let end = nextStart - 1;
      // trim surrounding blank lines (1-based line numbers)
      while (start <= end && isBlank(sourceLines[start - 1])) start++;
      while (end >= start && isBlank(sourceLines[end - 1])) end--;
      if (start <= end) resolved[i] = { start, end };
    }

    // pass 3: stamp (iterate backwards so template insertion keeps indices valid)
    for (let i = children.length - 1; i >= 0; i--) {
      const node = children[i]!;
      const pos = resolved[i];
      if (!pos) continue;
      const value = `${pos.start + offset}-${pos.end + offset}`;
      if (node.type === 'element') {
        node.properties ??= {};
        node.properties['data-wiki-src'] = value;
      } else if (node.type === 'mdxJsxFlowElement') {
        children.splice(i, 0, {
          type: 'element',
          tagName: 'template',
          properties: {
            'data-wiki-src': value,
            'data-wiki-jsx': node.name ?? 'component',
          },
          children: [],
        });
      }
    }

    // pass 4: the frontmatter anchor — only for the whole note, so a fragment
    // rendered against a note path gets none unless it is the note's tail,
    // where the inert template is harmless
    const frontmatter = raw !== null && wholeNote ? frontmatterLines(raw) : null;
    if (frontmatter) {
      children.unshift({
        type: 'element',
        tagName: 'template',
        properties: {
          'data-wiki-src': `${frontmatter.start}-${frontmatter.end}`,
          'data-wiki-frontmatter': '',
        },
        children: [],
      });
    }
  };
}

/** 1-based raw line range of the frontmatter block, opening fence to closing
 *  fence; null when the source has none */
export function frontmatterLines(raw: string): Pos | null {
  const fm = splitFrontmatter(raw);
  if (!fm.present) return null;
  const lineAt = (offset: number): number => raw.slice(0, offset).split('\n').length;
  // `end` is the offset just past the closing fence, on the fence's own line
  return { start: lineAt(fm.start), end: lineAt(fm.end) };
}
