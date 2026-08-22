/**
 * Block revision history popover (the ⟲ handle): lists revisions-journal
 * entries whose recorded line range overlaps the hovered block, each with a
 * collapsible before/after diff and a one-click revert. Whole-file records
 * (lines '*': translation, inbox import) appear as read-only audit rows —
 * who, when, via what — with a note that undoing them is a git operation.
 *
 * Revert is server-side (POST /revert with the revision's id): exact-match
 * replace of the revision's `after` span with its `before` — 409 when the
 * content has since diverged. A successful revert is journaled
 * (via:'revert'), autocommitted, and the page reloads through the same
 * HMR/scroll-restore path as a manual save.
 */
import type { RevisionRecord } from '../shared/types';
import { api } from './api';
import { currentUser } from './auth';
import type { BlockRef } from './blocks';
import type { PageContext } from './index';
import { rememberScroll } from './index';
import { S } from './strings';
import { h, popover, time, toast } from './ui';

/** recorded span overlaps the block's current span (heuristic: lines drift
 *  as the file is edited, but block-wise edits keep ranges close enough) */
function overlaps(rec: RevisionRecord, block: BlockRef): boolean {
  const m = /^(\d+)-(\d+)$/.exec(rec.lines);
  if (!m) return false;
  return Number(m[1]) <= block.end && Number(m[2]) >= block.start;
}

/** Exact content match: the record's before/after equals the block's current
 *  source verbatim — the strongest recovery signal once line numbers have
 *  drifted (the range overlap alone misses old records that truly belong to
 *  this block after heavy editing). Remaining limit: very old records that
 *  neither match exactly nor overlap can still be missed or mis-attributed —
 *  the journal has no stable block id, which is the ceiling of a
 *  line-number-based scheme. */
function contentHit(rec: RevisionRecord, source: string | null): boolean {
  if (!source) return false;
  const s = source.trim();
  return s.length > 0 && (rec.after.trim() === s || rec.before.trim() === s);
}

/** Read-only audit row for a whole-file record: no diff, no revert. */
function auditEntry(rec: RevisionRecord): HTMLElement {
  return h(
    'div',
    { class: 'wiki-history-entry', dataset: { revisionId: rec.id } },
    h(
      'div',
      { class: 'wiki-history-meta' },
      h('span', { class: 'wiki-badge-soft' }, S.history.via[rec.via] ?? rec.via),
      h('span', { class: 'wiki-history-who' }, `${rec.user} · `, time(rec.ts), ` · ${S.history.wholeFile}`),
    ),
    h('div', { class: 'wiki-history-note' }, S.history.wholeFileNote),
  );
}

function entry(ctx: PageContext, rec: RevisionRecord): HTMLElement {
  if (rec.lines === '*') return auditEntry(rec);
  const revertBtn = h(
    'button',
    {
      type: 'button',
      class: 'wiki-btn wiki-history-revert',
      title: S.history.revertTitle,
      onclick: async () => {
        if (!currentUser()) {
          toast(S.history.signInToRevert, 'err');
          return;
        }
        revertBtn.disabled = true;
        try {
          await api.post(`/revert/${ctx.meta.id}`, { id: rec.id });
          rememberScroll();
          toast(S.history.reverted);
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) {
          revertBtn.disabled = false;
          toast(err instanceof Error ? err.message : S.history.revertFailed, 'err');
        }
      },
    },
    S.history.revert,
  );
  return h(
    'div',
    { class: 'wiki-history-entry', dataset: { revisionId: rec.id } },
    h(
      'div',
      { class: 'wiki-history-meta' },
      h('span', { class: 'wiki-badge-soft' }, S.history.via[rec.via] ?? rec.via),
      h('span', { class: 'wiki-history-who' }, `${rec.user} · `, time(rec.ts), ` · L${rec.lines}`),
    ),
    h(
      'details',
      { class: 'wiki-history-diff' },
      h('summary', {}, S.history.viewDiff),
      h('pre', { class: 'wiki-diff-before' }, rec.before || S.editor.empty),
      h('pre', { class: 'wiki-diff-after' }, rec.after || S.editor.empty),
    ),
    revertBtn,
  );
}

/** `anchor` positions the popover; `trigger` is the button that owns it */
export async function openHistory(
  ctx: PageContext,
  block: BlockRef,
  anchor: HTMLElement,
  trigger: HTMLElement,
): Promise<void> {
  let recs: RevisionRecord[];
  try {
    const [resp, cur] = await Promise.all([
      api.get<{ revisions: RevisionRecord[] }>(`/revisions/${ctx.meta.id}`),
      // the block's current source: a content-level recovery channel for
      // records whose line numbers have drifted
      api
        .get<{ source: string }>(`/block/${ctx.meta.id}?start=${block.start}&end=${block.end}`)
        .then((b) => b.source)
        .catch(() => null),
    ]);
    // journal is append-ordered → newest first; whole-file ops ('*') always
    // concern this block and stay in the list as read-only audit rows
    recs = resp.revisions
      .filter((r) => r.lines === '*' || overlaps(r, block) || contentHit(r, cur))
      .reverse();
  } catch (err) {
    toast(err instanceof Error ? err.message : S.history.loadFailed, 'err');
    return;
  }
  const title = S.history.title(block.start, block.end);
  const body = h(
    'div',
    { class: 'wiki-history' },
    h('div', { class: 'wiki-panel-title' }, title),
    recs.length === 0
      ? h('div', { class: 'wiki-history-empty' }, S.history.noRecords)
      : h('div', { class: 'wiki-history-list' }, ...recs.slice(0, 20).map((r) => entry(ctx, r))),
  );
  popover(anchor, body, { label: title, trigger });
}
