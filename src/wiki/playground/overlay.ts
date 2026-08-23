/**
 * The overlay: how visitor edits meet the static page.
 *
 * Coordinate systems. The static build stamped every top-level block of a
 * note with its ORIGINAL source line range (`data-wiki-src="start-end"`) —
 * markdown blocks on the element itself, JSX components on an invisible
 * `<template>` anchor before their rendered output. Those stamps are
 * identical on every visit and form the stable key space. A visitor's edits
 * are per-segment source overrides keyed by that original range (store.ts).
 * The CURRENT source of the note is reconstructed deterministically:
 * original text outside the stamped segments (frontmatter, blank lines)
 * verbatim, each segment's override — or its original slice — in place.
 * Current line ranges follow from the walk.
 *
 * On boot the overlay re-stamps the page into CURRENT coordinates (so the
 * editor reads and writes the reconstructed source exactly like the dev
 * server reads and writes the file) and swaps edited segments' DOM for
 * locally rendered HTML.
 *
 * JSX components edit at the source level, exactly like dev mode (where the
 * editor shows their source with no preview). What differs is the page
 * after a save: dev re-renders server-side, a static bundle cannot run an
 * Astro component — so an edited segment whose source still carries JSX is
 * shown as its markdown rendering under an explanatory note, with a fresh
 * anchor keeping it editable, until Reset restores the built version.
 *
 * The frontmatter is a segment too (its anchor, bound by the client to the
 * layout's frontmatter slot): it edits as YAML, the visitor's version is
 * kept and reopened, and since a static page head cannot re-render from it
 * the slot carries an explanatory note until Reset.
 */

export interface StampedRange {
  start: number;
  end: number;
  /** component name when the stamp is a JSX `<template>` anchor */
  jsx: string | null;
  /** the note's frontmatter anchor */
  frontmatter: boolean;
}

export interface Segment extends StampedRange {
  /** "start-end" in ORIGINAL build coordinates — the override key */
  key: string;
  /** current source of the segment (override ?? original slice) */
  source: string;
  edited: boolean;
  curStart: number;
  curEnd: number;
}

export interface NoteOverlay {
  segments: Segment[];
  /** the reconstructed full source (what GET /block slices and PUT splices) */
  currentSource: string;
  blockAt(start: number, end: number): { source: string; start: number; end: number } | null;
  /** splice `source` over current lines start..end; returns the override to
   *  persist, or an error string (range outside any one segment) */
  applyEdit(start: number, end: number, source: string): { key: string; next: string } | string;
}

const linesOf = (s: string): string[] => s.split('\n');

/** does this source contain a JSX component tag? (the editor preview uses
 *  the same reading to decide "no preview") */
export function hasJsxSource(source: string): boolean {
  return /<[A-Z][\w]*[\s/>]/.test(source);
}

/** the stamped nodes — markdown elements, JSX anchors and the frontmatter
 *  anchor — in document order */
export function stampedNodes(root: Document | HTMLElement = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-wiki-src]')];
}

export function rangeOf(node: HTMLElement): StampedRange | null {
  const [start, end] = (node.dataset['wikiSrc'] ?? '').split('-').map(Number);
  if (!start || !end) return null;
  const frontmatter = node.tagName === 'TEMPLATE' && 'wikiFrontmatter' in node.dataset;
  return {
    start,
    end,
    jsx: node.tagName === 'TEMPLATE' && !frontmatter ? (node.dataset['wikiJsx'] ?? 'component') : null,
    frontmatter,
  };
}

export function buildOverlay(
  baseSource: string,
  ranges: StampedRange[],
  overrides: Record<string, string>,
): NoteOverlay | null {
  const baseLines = linesOf(baseSource);
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  // malformed stamps (out of bounds, overlapping) → no overlay, page stays read-only
  let prevEnd = 0;
  for (const r of ordered) {
    if (r.start < 1 || r.end < r.start || r.end > baseLines.length || r.start <= prevEnd) return null;
    prevEnd = r.end;
  }

  const segments: Segment[] = [];
  const parts: string[] = [];
  let cursor = 0; // count of current-source lines emitted so far
  let baseAt = 1; // next unconsumed ORIGINAL line
  for (const r of ordered) {
    const gap = baseLines.slice(baseAt - 1, r.start - 1);
    if (gap.length > 0) parts.push(gap.join('\n'));
    cursor += gap.length;
    const key = `${r.start}-${r.end}`;
    const override = overrides[key];
    const source = override ?? baseLines.slice(r.start - 1, r.end).join('\n');
    const segLines = linesOf(source);
    segments.push({
      ...r,
      key,
      source,
      edited: override !== undefined,
      curStart: cursor + 1,
      curEnd: cursor + segLines.length,
    });
    parts.push(source);
    cursor += segLines.length;
    baseAt = r.end + 1;
  }
  const tail = baseLines.slice(baseAt - 1);
  if (tail.length > 0) parts.push(tail.join('\n'));

  const currentSource = parts.join('\n');

  const containing = (start: number, end: number): Segment | null =>
    segments.find((s) => start >= s.curStart && end <= s.curEnd && start <= end) ?? null;

  return {
    segments,
    currentSource,
    blockAt(start, end) {
      const seg = containing(start, end);
      if (!seg) return null;
      const segLines = linesOf(seg.source);
      return {
        source: segLines.slice(start - seg.curStart, end - seg.curStart + 1).join('\n'),
        start,
        end,
      };
    },
    applyEdit(start, end, source) {
      const seg = containing(start, end);
      if (!seg) return `lines ${start}-${end} cross a read-only boundary`;
      const segLines = linesOf(seg.source);
      const next = [
        ...segLines.slice(0, start - seg.curStart),
        ...linesOf(source),
        ...segLines.slice(end - seg.curStart + 1),
      ].join('\n');
      return { key: seg.key, next };
    },
  };
}

export interface ApplyOptions {
  /** shown above an edited segment whose source still carries JSX */
  jsxEditedNote: string;
  /** shown under the frontmatter slot once the frontmatter is edited */
  frontmatterEditedNote: string;
  /** elements that end the content area — the DOM span of a trailing JSX
   *  segment must never swallow the layout's own chrome after the note body */
  contentEndSelector?: string | undefined;
}

const CONTENT_END = 'aside.backlinks, nav.pagination, footer';

/** the DOM nodes a segment owns: its stamped node, plus (for a JSX anchor)
 *  the component's rendered output — the following siblings up to the next
 *  segment's node, the content end, or the parent's end. `nested` reports a
 *  span member that CONTAINS another segment's node: a section-wrapping
 *  component (a chapter Hero) folds later blocks into its own output, and
 *  removing that span would take innocent content with it. */
function spanOf(
  node: HTMLElement,
  others: Set<HTMLElement>,
  next: HTMLElement | undefined,
  contentEnd: string,
): { span: ChildNode[]; nested: boolean } {
  const span: ChildNode[] = [node];
  let nested = false;
  if (node.tagName !== 'TEMPLATE') return { span, nested };
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (n === next) break;
    if (n instanceof Element) {
      if (n.matches(contentEnd)) break;
      for (const o of others) {
        if (n === o || n.contains(o)) {
          nested = true;
          break;
        }
      }
      if (nested) break;
    }
    span.push(n);
  }
  return { span, nested };
}

/**
 * Re-stamp the page into current coordinates and swap edited segments for
 * locally rendered HTML. `nodes` are the stamped nodes in document order —
 * they correspond 1:1 to `overlay.segments` (both derive from the same
 * original stamps).
 */
export async function applyOverlayToDom(
  overlay: NoteOverlay,
  nodes: HTMLElement[],
  renderBlock: (source: string, curStart: number) => Promise<string>,
  opts: ApplyOptions,
): Promise<void> {
  if (nodes.length !== overlay.segments.length) return;
  const contentEnd = opts.contentEndSelector ?? CONTENT_END;
  for (let i = 0; i < overlay.segments.length; i++) {
    const seg = overlay.segments[i]!;
    const node = nodes[i]!;
    if (!seg.edited) {
      node.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      continue;
    }

    if (seg.frontmatter) {
      // the anchor moves to current coordinates (the editor keeps working on
      // the saved YAML); the page head is the layout's build-time rendering
      // and cannot follow, so the slot says so until Reset
      node.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      const slot = document.querySelector('[data-inkbrush-slot="frontmatter"]');
      if (slot) {
        const note = document.createElement('div');
        note.className = 'pg-jsx-note';
        note.textContent = opts.frontmatterEditedNote;
        slot.insertAdjacentElement('afterend', note);
      }
      continue;
    }

    const othersSet = new Set(nodes.filter((n) => n !== node));
    const { span, nested } = spanOf(node, othersSet, nodes[i + 1], contentEnd);

    if (nested) {
      // a section-wrapping component: its output folds later blocks in, so
      // the built rendering stays on the page. The anchor moves to current
      // coordinates (the editor keeps working on the saved source) and a
      // note says the display still shows the built version until Reset.
      node.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      const note = document.createElement('div');
      note.className = 'pg-jsx-note';
      note.textContent = opts.jsxEditedNote;
      node.parentNode?.insertBefore(note, node.nextSibling);
      continue;
    }

    const html = await renderBlock(seg.source, seg.curStart);
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const rendered = [...tpl.content.children] as HTMLElement[];

    const replacement: (HTMLElement | Text)[] = [];
    if (hasJsxSource(seg.source)) {
      // dev re-renders the component server-side after a save; a static page
      // cannot, so the segment keeps a fresh anchor (still editable) and its
      // markdown rendering sits under an explanatory note until Reset
      const anchor = document.createElement('template');
      anchor.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      anchor.dataset['wikiJsx'] = seg.jsx ?? 'component';
      const note = document.createElement('div');
      note.className = 'pg-jsx-note';
      note.textContent = opts.jsxEditedNote;
      replacement.push(anchor, note, ...rendered);
    } else if (rendered.length > 0) {
      // the fragment renderer stamps its own top-level blocks (shifted to
      // current lines); a first node left unstamped still needs the segment
      // range so the block stays reachable
      if (!rendered[0]!.hasAttribute('data-wiki-src')) {
        rendered[0]!.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      }
      replacement.push(...rendered);
    }
    // an emptied segment (the visitor deleted everything) leaves no nodes:
    // it comes back with the reset button

    const first = span[0]!;
    for (const n of replacement) first.parentNode?.insertBefore(n, first);
    for (const n of span) (n as ChildNode).remove();
  }
}
