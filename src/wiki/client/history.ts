/**
 * Block revision history popover (the ⟲ handle): lists revisions-journal
 * entries whose recorded line range overlaps the hovered block, each with a
 * collapsible before/after diff and a one-click revert.
 *
 * Revert is server-side (POST /revert): exact-match replace of the revision's
 * `after` span with its `before` — 409 when the content has since diverged.
 * A successful revert is journaled (via:'revert'), autocommitted, and the
 * page reloads through the same HMR/scroll-restore path as a manual save.
 */
import type { RevisionRecord } from '../shared/types';
import { api } from './api';
import { currentUser } from './auth';
import type { BlockRef } from './blocks';
import type { PageContext } from './index';
import { dateLocale, S } from './strings';
import { h, popover, toast } from './ui';

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

function entry(ctx: PageContext, rec: RevisionRecord): HTMLElement {
  const when = new Date(rec.ts).toLocaleString(dateLocale, { hour12: false });
  const revertBtn = h(
    'button',
    {
      class: 'wiki-btn wiki-history-revert',
      title: S.history.revertTitle,
      onclick: async () => {
        if (!currentUser()) {
          toast(S.history.signInToRevert, 'err');
          return;
        }
        revertBtn.setAttribute('disabled', 'true');
        try {
          await api.post(`/revert/${ctx.meta.id}`, { ts: rec.ts });
          toast(S.history.reverted);
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) {
          revertBtn.removeAttribute('disabled');
          toast(err instanceof Error ? err.message : S.history.revertFailed, 'err');
        }
      },
    },
    S.history.revert,
  );
  return h(
    'div',
    { class: 'wiki-history-entry' },
    h(
      'div',
      { class: 'wiki-history-meta' },
      h('span', { class: 'wiki-badge-soft' }, S.history.via[rec.via] ?? rec.via),
      h('span', { class: 'wiki-history-who' }, `${rec.user} · ${when} · L${rec.lines}`),
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

export async function openHistory(ctx: PageContext, block: BlockRef, anchor: HTMLElement): Promise<void> {
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
    // journal is append-ordered → newest first; whole-file ops ('*') excluded
    recs = resp.revisions
      .filter((r) => r.lines !== '*' && (overlaps(r, block) || contentHit(r, cur)))
      .reverse();
  } catch (err) {
    toast(err instanceof Error ? err.message : S.history.loadFailed, 'err');
    return;
  }
  const body = h(
    'div',
    { class: 'wiki-history' },
    h('div', { class: 'wiki-panel-title' }, S.history.title(block.start, block.end)),
    recs.length === 0
      ? h('div', { class: 'wiki-history-empty' }, S.history.noRecords)
      : h('div', { class: 'wiki-history-list' }, ...recs.slice(0, 20).map((r) => entry(ctx, r))),
  );
  popover(anchor, body);
}
