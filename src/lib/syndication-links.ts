/**
 * syndication-links — the links of a note as the renderer sees them, and
 * the proof that a copy still reads as the original.
 *
 * Wikilinks are found with the renderer's own recognizer
 * (wikilink-core's findWikilinks): on the parser's text nodes, decoded,
 * escapes honoured, each match mapped back to its source span.
 *
 * A copy is verified, never trusted: its parsed tree must equal the
 * original's tree with every degraded link replaced by its visible text
 * and every rewritten wikilink by its new spelling — same node types and
 * nesting, same ESM, expressions, JSX and attributes, same text — and the
 * wikilinks the renderer would make of the copy must be exactly the ones
 * intended: the kept and the rewritten, in order, with the same targets,
 * anchors and labels. Nothing about how the replacements were escaped
 * enters the proof.
 */
import { stableJson } from './syndication-bundle.ts';
import { findWikilinks, type WikilinkMatch } from './wikilink-core.ts';
import type { SourceNode } from './wikilinks.ts';

/** the path of child indexes from the root to a node */
export type NodePath = readonly number[];

/** a wikilink as the verifier compares them: target, anchor and label as the renderer resolves and shows them */
export type LinkShape = readonly [target: string, anchor: string | null, label: string | null];

export function linkShape(match: Pick<WikilinkMatch, 'target' | 'anchor' | 'label'>): LinkShape {
  return [match.target, match.anchor ?? null, match.label ?? null];
}

/* ---------------- verification ---------------- */

/** what a link in the original tree becomes in the copy's */
export type Replacement =
  /** a text node's value with [valueStart, valueEnd) replaced by `text` */
  | { kind: 'text'; path: NodePath; valueStart: number; valueEnd: number; text: string }
  /** a node replaced by its own children */
  | { kind: 'unwrap'; path: NodePath };

function nodeAt(tree: SourceNode, path: NodePath): SourceNode {
  let node = tree;
  for (const i of path) node = node.children![i]!;
  return node;
}

/**
 * The original tree with `replacements` applied. Replacements are applied
 * in the order given — the caller orders them from the end of the source
 * backwards, so a splice never disturbs a path applied later.
 */
export function expectedTree(original: SourceNode, replacements: readonly Replacement[]): SourceNode {
  const tree = structuredClone(original);
  for (const r of replacements) {
    if (r.kind === 'text') {
      const node = nodeAt(tree, r.path) as { value?: string };
      const value = node.value ?? '';
      node.value = value.slice(0, r.valueStart) + r.text + value.slice(r.valueEnd);
    } else {
      const parent = nodeAt(tree, r.path.slice(0, -1));
      const index = r.path[r.path.length - 1]!;
      const node = parent.children![index]!;
      parent.children!.splice(index, 1, ...(node.children ?? []));
    }
  }
  return tree;
}

/** a tree as compared: positions and parser data dropped, adjacent text
 *  nodes merged, every other field kept */
function normalized(node: SourceNode): unknown {
  const { position: _position, data: _data, children, ...fields } = node as SourceNode & { data?: unknown };
  const out = strip(fields) as Record<string, unknown>;
  if (children) {
    const merged: SourceNode[] = [];
    for (const child of children) {
      const last = merged[merged.length - 1];
      if (child.type === 'text' && last?.type === 'text') {
        (last as { value?: string }).value = ((last as { value?: string }).value ?? '') + ((child as { value?: string }).value ?? '');
      } else merged.push(child.type === 'text' ? { ...child } : child);
    }
    out['children'] = merged.map(normalized);
  }
  return out;
}

/** nested objects (JSX attributes and their expression values) without positions or parser data */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'position' || k === 'data') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/** the two trees read the same */
export function sameTree(a: SourceNode, b: SourceNode): boolean {
  return stableJson(normalized(a)) === stableJson(normalized(b));
}

/** the wikilinks the renderer makes of the copy are exactly `intended`, in order */
export function sameLinks(copy: SourceNode, copySource: string, intended: readonly LinkShape[]): boolean {
  const found = findWikilinks(copy, copySource).map(linkShape);
  return stableJson(found) === stableJson(intended);
}
