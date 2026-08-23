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

export function rehypeWikiBlocks() {
  return async (tree: Root, file: VFile): Promise<void> => {
    const value = String(file.value);
    const sourceLines = value.split('\n');
    const children = tree.children as unknown as AnyNode[];

    // Stamps must be RAW file lines — the server reads and writes blocks by
    // them. A pipeline that strips the frontmatter before parsing (Astro's
    // own .md path) yields body-relative positions and a body-only vfile
    // value; the raw file on disk tells the difference, and the stamp then
    // carries the frontmatter offset. A pipeline whose positions already
    // count the frontmatter (MDX) needs none. node:fs loads lazily inside
    // the branch: the plugin also runs in browser bundles (the playground
    // renders patched blocks with it), where the vfile carries no path and
    // fs must never be resolved at module load.
    let offset = 0;
    if (!splitFrontmatter(value).present && file.path) {
      let raw: string | null = null;
      try {
        const fs = await import('node:fs');
        raw = fs.readFileSync(file.path, 'utf8');
      } catch {
        raw = null;
      }
      if (raw !== null) {
        const fm = splitFrontmatter(raw);
        // the body starts on the line after the closing fence: the offset is
        // the number of raw lines the block (and anything before it) occupies
        if (fm.present) offset = raw.slice(0, fm.end).split('\n').length;
      }
    }

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
  };
}
