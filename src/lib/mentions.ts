/**
 * mentions — the `@handle` grammar and its remark transform (subpath export
 * astro-inkbrush/mentions; browser-safe, like ./wikilink-core.ts).
 *
 * Syntax: `@` followed by a member's handle (./people.ts: their email's
 * local part), e.g. `@jane.doe`. The `@` must not follow an ASCII letter,
 * digit or one of `_ . / \ @ -`, so an email address (`jane@team.com`), a
 * package scope (`pkg/@scope`) or a path never reads as a mention; any other
 * character before it — a space, punctuation, a CJK character — is fine.
 * A handle ends at its last letter or digit, so trailing sentence
 * punctuation (`@jane.doe.`) stays text; what follows it may not continue
 * the handle (a letter, digit or `_`, possibly after `.` or `-`) nor reach
 * an `@` — so `@jane.doe@team.com` is an address, never `@jane`.
 *
 * Resolution is the site's: `resolve(handle)` returns how the member is
 * shown (name and the page about them) or undefined; an unresolved `@word`
 * stays literal text, so prose that happens to contain one (`@decorator`,
 * `@here`) is never touched. Code, inline code, math and existing links are
 * never entered, and a backslash-escaped `\@` is literal (read back from the
 * source the way the wikilink recognizer does).
 *
 * The source keeps the handle, never the name: a renamed member is renamed
 * in every note at the next render, and translations carry `@handle`
 * verbatim.
 */
import { mapValueToSource, wikilinkMatches } from './wikilink-core.ts';

/** `@handle` in a text value; group 1 = the handle (case kept; resolution lowercases) */
export const MENTION_RE = /(?<![A-Za-z0-9_./\\@-])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?![A-Za-z0-9._-]*[A-Za-z0-9_@])/g;

/** node types the mention transform never enters */
const NO_DESCEND: ReadonlySet<string> = new Set(['link', 'linkReference', 'code', 'inlineCode', 'math', 'inlineMath', 'wikilinkDead']);

export interface MentionTarget {
  /** how the member is named */
  name: string;
  /** the page about the member */
  url: string;
}

export type MentionResolver = (handle: string) => MentionTarget | undefined;

/** one mention in a text value */
export interface MentionMatch {
  handle: string;
  valueStart: number;
  valueEnd: number;
}

/** the mentions in one text node's value — an escaped `\@` and an `@` inside a `[[wikilink]]` left out (`source`/`start` locate the node, as for wikilinks) */
export function mentionMatches(value: string, source: string | null, start: number | undefined): MentionMatch[] {
  if (!value.includes('@')) return [];
  const mapping = source !== null && start !== undefined ? mapValueToSource(source, start, value) : null;
  const links = wikilinkMatches(value, source, start);
  const out: MentionMatch[] = [];
  for (const m of value.matchAll(MENTION_RE)) {
    const idx = m.index ?? 0;
    if (mapping?.escaped[idx]) continue;
    if (links.some((l) => idx >= l.valueStart && idx < l.valueEnd)) continue;
    out.push({ handle: m[1]!.toLowerCase(), valueStart: idx, valueEnd: idx + m[0].length });
  }
  return out;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const startOffsetOf = (node: MdNode): number | undefined =>
  (node as { position?: { start?: { offset?: number } } }).position?.start?.offset;

/** every text node the mention grammar reads, in document order: code, math, links and dead wikilinks are never entered */
function eachMentionText(tree: MdNode, visit: (node: MdNode, siblings: MdNode[], index: number) => number | void): void {
  const walk = (node: MdNode): void => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i]!;
      if (NO_DESCEND.has(child.type)) continue;
      if (child.type === 'text') {
        const skip = visit(child, children, i);
        if (typeof skip === 'number') i += skip;
        continue;
      }
      walk(child);
    }
  };
  walk(tree);
}

/**
 * remark transform: every resolved `@handle` becomes a link to the member's
 * page, showing their name — `<a class="mention" data-mention="jane.doe"
 * href="…">Jane Doe</a>`.
 */
export function remarkMentions(opts: { resolve: MentionResolver }) {
  return (tree: MdNode, file?: { value?: unknown }): void => {
    const source = typeof file?.value === 'string' ? file.value : null;
    eachMentionText(tree, (node, siblings, index) => {
      const value = node.value ?? '';
      const out: MdNode[] = [];
      let last = 0;
      for (const { handle, valueStart, valueEnd } of mentionMatches(value, source, startOffsetOf(node))) {
        const target = opts.resolve(handle);
        if (!target) continue;
        if (valueStart > last) out.push({ type: 'text', value: value.slice(last, valueStart) });
        out.push({
          type: 'link',
          url: target.url,
          data: { hProperties: { className: ['mention'], 'data-mention': handle } },
          children: [{ type: 'text', value: target.name }],
        } as MdNode);
        last = valueEnd;
      }
      if (out.length === 0) return;
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
      siblings.splice(index, 1, ...out);
      return out.length - 1;
    });
  };
}

/** the handles a parsed tree mentions — exactly the `@handle`s remarkMentions would consider, before resolution (`source` is the text the tree was parsed from) */
export function mentionsInTree(tree: MdNode, source: string | null): Set<string> {
  const handles = new Set<string>();
  eachMentionText(tree, (node) => {
    for (const { handle } of mentionMatches(node.value ?? '', source, startOffsetOf(node))) handles.add(handle);
  });
  return handles;
}
