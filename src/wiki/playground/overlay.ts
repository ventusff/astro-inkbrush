/**
 * The overlay: how visitor edits meet the static page.
 *
 * Coordinate systems. The static build stamped every top-level markdown
 * block with its ORIGINAL source line range (`data-wiki-src="start-end"`) —
 * those stamps are identical on every visit and form the stable key space.
 * A visitor's edits are per-segment source overrides keyed by that original
 * range (store.ts). The CURRENT source of the note is reconstructed
 * deterministically: original text outside the stamped segments (frontmatter,
 * blank lines, JSX component blocks) verbatim, each segment's override — or
 * its original slice — in place. Current line ranges follow from the walk.
 *
 * On boot the overlay re-stamps the page into CURRENT coordinates (so the
 * editor reads and writes the reconstructed source exactly like the dev
 * server reads and writes the file) and swaps edited segments' DOM for
 * locally rendered HTML.
 *
 * JSX component blocks are read-only here: their `<template>` anchors lose
 * the stamp before block discovery runs. Rendering an Astro island in the
 * browser is not something a static bundle can do, so the playground does
 * not pretend otherwise (the dev-mode editor has the matching boundary: it
 * edits their source but previews nothing).
 */

export interface Segment {
  /** "start-end" in ORIGINAL build coordinates — the override key */
  key: string;
  origStart: number;
  origEnd: number;
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

/** strip the stamps off JSX `<template>` anchors — read-only in the playground */
export function disableJsxAnchors(root: Document | HTMLElement = document): void {
  for (const t of root.querySelectorAll('template[data-wiki-src]')) {
    t.removeAttribute('data-wiki-src');
    t.removeAttribute('data-wiki-jsx');
  }
}

/** the stamped block elements, in document order (JSX anchors already stripped) */
export function stampedElements(root: Document | HTMLElement = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-wiki-src]')];
}

export function buildOverlay(
  baseSource: string,
  origRanges: { start: number; end: number }[],
  overrides: Record<string, string>,
): NoteOverlay | null {
  const baseLines = linesOf(baseSource);
  const ranges = [...origRanges].sort((a, b) => a.start - b.start);
  // malformed stamps (out of bounds, overlapping) → no overlay, page stays read-only
  let prevEnd = 0;
  for (const r of ranges) {
    if (r.start < 1 || r.end < r.start || r.end > baseLines.length || r.start <= prevEnd) return null;
    prevEnd = r.end;
  }

  const segments: Segment[] = [];
  const parts: string[] = [];
  let cursor = 0; // count of current-source lines emitted so far
  let baseAt = 1; // next unconsumed ORIGINAL line
  for (const r of ranges) {
    const gap = baseLines.slice(baseAt - 1, r.start - 1);
    if (gap.length > 0) parts.push(gap.join('\n'));
    cursor += gap.length;
    const key = `${r.start}-${r.end}`;
    const override = overrides[key];
    const source = override ?? baseLines.slice(r.start - 1, r.end).join('\n');
    const segLines = linesOf(source);
    segments.push({
      key,
      origStart: r.start,
      origEnd: r.end,
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

/**
 * Re-stamp the page into current coordinates and swap edited segments for
 * locally rendered HTML. `elements` are the stamped blocks in document order
 * — they correspond 1:1 to `overlay.segments` (both derive from the same
 * original stamps).
 */
export async function applyOverlayToDom(
  overlay: NoteOverlay,
  elements: HTMLElement[],
  renderBlock: (source: string, curStart: number) => Promise<string>,
): Promise<void> {
  if (elements.length !== overlay.segments.length) return;
  for (let i = 0; i < overlay.segments.length; i++) {
    const seg = overlay.segments[i]!;
    const el = elements[i]!;
    if (!seg.edited) {
      el.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
      continue;
    }
    const html = await renderBlock(seg.source, seg.curStart);
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const nodes = [...tpl.content.children] as HTMLElement[];
    if (nodes.length === 0) {
      // the visitor deleted the whole segment: nothing to show, nothing to
      // grab — the segment comes back with the reset button
      el.remove();
      continue;
    }
    // the fragment renderer stamps its own top-level blocks (shifted to
    // current lines); a first node left unstamped still needs the segment
    // range so the block stays reachable
    if (!nodes[0]!.hasAttribute('data-wiki-src')) {
      nodes[0]!.dataset['wikiSrc'] = `${seg.curStart}-${seg.curEnd}`;
    }
    el.replaceWith(...nodes);
  }
}
