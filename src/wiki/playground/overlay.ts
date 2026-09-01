/**
 * The overlay: how visitor edits meet the static page.
 *
 * Coordinate systems. The static build stamped every block of a note with
 * its ORIGINAL source line range (`data-wiki-src="start-end"`) — markdown
 * blocks on the element itself, JSX components and raw HTML blocks on an
 * invisible `<template>` anchor before their rendered output, footnote
 * definitions on their `li` in the footnote section, the frontmatter on an
 * anchor the client binds to the layout's slot. Those stamps are identical
 * on every visit and form the stable key space. A visitor's edits are
 * per-segment source overrides keyed by that original range (store.ts).
 * The CURRENT source of the note is reconstructed deterministically:
 * original text outside the stamped segments (import lines, blank lines)
 * verbatim, each segment's override — or its original slice — in place.
 * Current line ranges follow from the walk.
 *
 * Segments are ordered by source line; the page's stamped nodes come in
 * document order, which differs from source order wherever rendering
 * hoists content (the footnote section at the end of the document). The
 * two are matched by stamp key, never by position.
 *
 * On boot the overlay re-stamps the page into CURRENT coordinates (so the
 * editor reads and writes the reconstructed source exactly like the dev
 * server reads and writes the file) and swaps each edited segment's DOM
 * for its source rendered on its own through the site's pipeline — the
 * same fragment reading the editor's preview shows. A segment renders on
 * its own for a reason: JSX lands in this pipeline as raw markup, and a
 * self-closing component tag would fold everything after it into one
 * element if the note were parsed as one document. The footnote section is
 * the exception — a product of the whole document (which definitions are
 * referenced, in what order) — and is rebuilt from the whole current body
 * whenever an edit could have changed it.
 *
 * JSX components edit at the source level, exactly like dev mode (where the
 * editor shows their source with no preview). What differs is the page
 * after a save: dev re-renders server-side, a static bundle cannot run an
 * Astro component — so an edited segment whose source still carries JSX is
 * shown as its markdown rendering under an explanatory note, behind the
 * anchor that keeps it editable, until Reset restores the built version.
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
  /** in source order */
  segments: Segment[];
  /** the reconstructed full source (what GET /block slices and PUT splices) */
  currentSource: string;
  /** the segment stamped with `key` in the build */
  segmentOf(key: string): Segment | undefined;
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

/** the stamped nodes — markdown elements, anchors and footnote items — in
 *  document order */
export function stampedNodes(root: Document | HTMLElement = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-wiki-src]')];
}

export function rangeOf(node: HTMLElement): StampedRange | null {
  const [start, end] = (node.dataset['wikiSrc'] ?? '').split('-').map(Number);
  if (!start || !end) return null;
  const anchor = node.tagName === 'TEMPLATE';
  const frontmatter = anchor && 'wikiFrontmatter' in node.dataset;
  return {
    start,
    end,
    jsx: anchor && !frontmatter ? (node.dataset['wikiJsx'] ?? null) : null,
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
  const byKey = new Map(segments.map((s) => [s.key, s]));

  const containing = (start: number, end: number): Segment | null =>
    segments.find((s) => start >= s.curStart && end <= s.curEnd && start <= end) ?? null;

  return {
    segments,
    currentSource,
    segmentOf: (key) => byKey.get(key),
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
const FOOTNOTES = 'section[data-footnotes]';

/** the DOM nodes a segment owns: its stamped node, plus (for an anchor) the
 *  rendered output — the following siblings up to the next stamped node in
 *  document order, the content end, or the parent's end. `nested` reports a
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

/** the 1-based line the note body starts on: after the frontmatter block,
 *  else the first line. The frontmatter splitter (a YAML parser) is loaded
 *  here, on the one path that needs it, and never by activation itself. */
async function bodyStartOf(source: string): Promise<number> {
  const { splitFrontmatter } = await import('../../lib/frontmatter.ts');
  const fm = splitFrontmatter(source);
  return fm.present ? source.slice(0, fm.end).split('\n').length + 1 : 1;
}

/** a footnote definition anywhere in the source */
const FOOTNOTE_DEFINITION = /^[ \t]*\[\^[^\]]+\]:/m;

/** an edited segment's own rendering: its top-level elements, stamped in
 *  current coordinates (a first element left unstamped takes the segment's
 *  range, so the block stays reachable; a component anchor keeps the
 *  component's name). A footnote section the fragment produced is
 *  dropped — the page's section is rebuilt from the whole body. */
function renderedBlocks(html: string, seg: Segment): HTMLElement[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelector(FOOTNOTES)?.remove();
  const blocks = [...tpl.content.children] as HTMLElement[];
  const first = blocks[0];
  if (first && !first.hasAttribute('data-wiki-src')) {
    first.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
  }
  if (first && seg.jsx && first.matches('template[data-wiki-html]')) {
    first.dataset['wikiJsx'] = seg.jsx;
    delete first.dataset['wikiHtml'];
  }
  return blocks;
}

/** where a footnote section goes on a page that had none: after the last
 *  block of the body (an anchor's output included) */
function bodyEnd(contentEnd: string): Element | null {
  const stamped = [...document.querySelectorAll<HTMLElement>('[data-wiki-src]')].filter(
    (n) => !n.closest(FOOTNOTES) && !('wikiFrontmatter' in n.dataset),
  );
  let at: Element | null = stamped[stamped.length - 1] ?? null;
  if (at?.tagName === 'TEMPLATE') {
    for (let el = at.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.hasAttribute('data-wiki-src') || el.matches(contentEnd)) break;
      at = el;
    }
  }
  return at;
}

/**
 * Re-stamp the page into current coordinates and swap edited segments for
 * their locally rendered blocks. `nodes` are the page's stamped nodes in
 * document order; each is matched to its segment by stamp key. A page whose
 * stamps do not match the overlay one-to-one is left untouched.
 */
export async function applyOverlayToDom(
  overlay: NoteOverlay,
  nodes: HTMLElement[],
  renderSource: (source: string, first: number) => Promise<string>,
  opts: ApplyOptions,
): Promise<void> {
  const nodeOf = new Map<string, HTMLElement>();
  for (const node of nodes) {
    const key = node.dataset['wikiSrc'] ?? '';
    if (!key || nodeOf.has(key)) return;
    nodeOf.set(key, node);
  }
  if (nodeOf.size !== overlay.segments.length || overlay.segments.some((s) => !nodeOf.has(s.key))) {
    return;
  }
  const contentEnd = opts.contentEndSelector ?? CONTENT_END;

  for (const seg of overlay.segments) {
    if (!seg.edited) nodeOf.get(seg.key)!.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
  }
  const edited = overlay.segments.filter((s) => s.edited);
  if (edited.length === 0) return;

  const section =
    nodes.map((n) => n.closest<HTMLElement>(FOOTNOTES)).find((s) => s !== null) ??
    document.querySelector<HTMLElement>(FOOTNOTES);
  const nodeSet = new Set(nodes);
  for (const seg of edited) {
    const node = nodeOf.get(seg.key)!;
    // the anchor moves to current coordinates in every case where the built
    // rendering stays on the page
    node.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;

    if (seg.frontmatter) {
      // the page head is the layout's build-time rendering and cannot
      // follow the edit; the slot says so until Reset
      const slot = document.querySelector('[data-inkbrush-slot="frontmatter"]');
      if (slot) {
        const note = document.createElement('div');
        note.className = 'pg-jsx-note';
        note.textContent = opts.frontmatterEditedNote;
        slot.insertAdjacentElement('afterend', note);
      }
      continue;
    }
    // a footnote item is replaced with the whole section below
    if (section?.contains(node)) continue;

    const others = new Set([...nodeSet].filter((n) => n !== node));
    const { span, nested } = spanOf(node, others, nodes[nodes.indexOf(node) + 1], contentEnd);
    if (nested) {
      // a section-wrapping component: its output folds later blocks in, so
      // the built rendering stays on the page under a note saying so
      const note = document.createElement('div');
      note.className = 'pg-jsx-note';
      note.textContent = opts.jsxEditedNote;
      node.parentNode?.insertBefore(note, node.nextSibling);
      continue;
    }

    const replacement: HTMLElement[] = renderedBlocks(
      await renderSource(seg.source, seg.curStart),
      seg,
    );
    if (hasJsxSource(seg.source)) {
      // dev re-renders the component server-side after a save; a static page
      // cannot, so the markdown rendering (its anchor keeps it editable)
      // sits under an explanatory note until Reset
      const note = document.createElement('div');
      note.className = 'pg-jsx-note';
      note.textContent = opts.jsxEditedNote;
      replacement.unshift(note);
    }
    // an emptied segment (the visitor deleted everything) leaves no nodes:
    // it comes back with the reset button
    const first = span[0]!;
    for (const n of replacement) first.parentNode?.insertBefore(n, first);
    for (const n of span) n.remove();
  }

  // the footnote section follows the whole document: rebuilt from the
  // current body whenever the page has one or the source defines one
  if (section || FOOTNOTE_DEFINITION.test(overlay.currentSource)) {
    const bodyStart = await bodyStartOf(overlay.currentSource);
    const body = overlay.currentSource.split('\n').slice(bodyStart - 1).join('\n');
    const tpl = document.createElement('template');
    tpl.innerHTML = await renderSource(body, bodyStart);
    const next = tpl.content.querySelector<HTMLElement>(FOOTNOTES);
    if (next) {
      if (section) section.replaceWith(next);
      else bodyEnd(contentEnd)?.after(next);
    } else {
      section?.remove();
    }
  }
}
