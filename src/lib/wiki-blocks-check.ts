/**
 * Block-stamp invariants — what every consumer of the rehype-wiki-blocks
 * output relies on. A stamp is `data-wiki-src="start-end"`: 1-based,
 * inclusive raw source lines, on a markdown element, on a `<template>`
 * anchor (a JSX component, a raw HTML block, the frontmatter) or on an item
 * of the footnote section.
 *
 *  1. well-formed — two integers, 1 ≤ start ≤ end, end within the source;
 *  2. disjoint — no two stamps share a line: the editor reads and writes a
 *     block by its lines, and an overlap would let one block's save rewrite
 *     another block's text;
 *  3. reachable — every top-level block (an element, a JSX component, a raw
 *     HTML block) carries a stamp or stands behind an anchor: an unstamped
 *     block is one the editor can never open.
 *
 * check-content verifies them per note; a violation is a finding.
 */
import type { Root } from 'hast';

import { footnoteItems, isFootnoteSection } from './rehype-wiki-blocks.ts';

type AnyNode = {
  type: string;
  name?: string;
  tagName?: string;
  children?: AnyNode[];
  properties?: Record<string, unknown>;
} & Record<string, unknown>;

export interface BlockStamp {
  start: number;
  end: number;
  /** the stamped node, for messages: `<p>`, `<template data-wiki-jsx="Hero">`, … */
  where: string;
  /** the attribute value as written; null when it is not `start-end` */
  raw: string;
}

function stampValue(node: AnyNode): string | undefined {
  const value = node.properties?.['data-wiki-src'];
  return typeof value === 'string' ? value : undefined;
}

function isAnchor(node: AnyNode): boolean {
  return node.type === 'element' && node.tagName === 'template' && stampValue(node) !== undefined;
}

function describe(node: AnyNode): string {
  if (node.type === 'element' && node.tagName === 'template') {
    const p = node.properties ?? {};
    if (p['data-wiki-frontmatter'] !== undefined) return '<template data-wiki-frontmatter>';
    if (p['data-wiki-html'] !== undefined) return '<template data-wiki-html>';
    return `<template data-wiki-jsx="${String(p['data-wiki-jsx'] ?? '')}">`;
  }
  if (node.type === 'element') return `<${node.tagName ?? 'element'}>`;
  if (node.type === 'mdxJsxFlowElement') return `<${node.name ?? 'component'}>`;
  return node.type;
}

/** every stamp of the tree, in document order, plus every block without one */
export function collectStamps(tree: Root): { stamps: BlockStamp[]; unstamped: string[] } {
  const children = tree.children as unknown as AnyNode[];
  const stamps: BlockStamp[] = [];
  const unstamped: string[] = [];
  const record = (node: AnyNode, raw: string): void => {
    const m = /^(\d+)-(\d+)$/.exec(raw);
    stamps.push({
      start: m ? Number(m[1]) : NaN,
      end: m ? Number(m[2]) : NaN,
      where: describe(node),
      raw,
    });
  };
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (isFootnoteSection(node)) {
      for (const li of footnoteItems(node)) {
        const raw = stampValue(li);
        if (raw === undefined) unstamped.push('<li> (footnote)');
        else record(li, raw);
      }
      continue;
    }
    if (node.type === 'element') {
      const raw = stampValue(node);
      if (raw !== undefined) record(node, raw);
      else if (node.tagName !== 'template') unstamped.push(describe(node));
      continue;
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'raw') {
      const before = children[i - 1];
      if (!before || !isAnchor(before)) unstamped.push(describe(node));
    }
  }
  return { stamps, unstamped };
}

/**
 * The invariant violations of a stamped tree, as messages; empty when the
 * block map is sound. `lineCount` (the source's line count) bounds the
 * ranges when given.
 */
export function blockStampProblems(tree: Root, lineCount?: number): string[] {
  const problems: string[] = [];
  const { stamps, unstamped } = collectStamps(tree);
  const valid: BlockStamp[] = [];
  for (const s of stamps) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 1 || s.end < s.start) {
      problems.push(`${s.where} carries a malformed range "${s.raw}"`);
    } else if (lineCount !== undefined && s.end > lineCount) {
      problems.push(`${s.where} L${s.start}-${s.end} runs past the last line (${lineCount})`);
    } else {
      valid.push(s);
    }
  }
  const ordered = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (cur.start <= prev.end) {
      problems.push(
        `${prev.where} L${prev.start}-${prev.end} and ${cur.where} L${cur.start}-${cur.end} overlap`,
      );
    }
  }
  for (const where of unstamped) problems.push(`${where} has no source range — the editor cannot reach it`);
  return problems;
}
