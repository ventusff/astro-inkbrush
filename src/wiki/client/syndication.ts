/**
 * Syndication chips — where this note stands on the wikis it publishes to,
 * mounted on note pages next to the share chip, into the site's
 * `[data-inkbrush-slot="share"]` slot.
 *
 * One chip per peer (/me → syndication.peers), for signed-in users: the
 * peer's title and a dot for the unit's standing there — no dot: not synced
 * · current · behind (this note changed since) · checking (an operation runs
 * or waits, or the peer's checks have not decided) · conflict (edited there,
 * the address taken, returned by the checks) · off (unreachable, or the note
 * cannot be synced). The popover explains the standing and offers what fits
 * it: publish, adopt the peer's own note at this address, overwrite edits
 * made there, withdraw, and the per-peer classification overrides; its
 * footer lists every note synced to that peer, with "publish all behind".
 *
 * Everything reads from and acts through the page's PeerSync (one per peer,
 * syndication-state.ts): operations outlive the popover, a queued or running
 * operation shows in every view, and each ending is toasted once. While a
 * submission is unresolved, an open popover re-reads it every 15 s.
 *
 * On a copy synced INTO this wiki (`meta.origin`) the one chip names its
 * origin and explains that the copy is edited there.
 */
import type {
  CopyOrigin,
  CopyState,
  SyndicationNoteResponse,
  SyndicationOverviewCopy,
  SyndicationPlan,
  SyndicationRefusal,
  SyndicationUnitStatus,
} from '../shared/types';
import { api } from './api';
import { currentUser, onAuthChange, syndicationPeers } from './auth';
import type { PageContext } from './index';
import { formatDate, S } from './strings';
import { type Attempt, type Failure, failureOf, type Job, PeerSync } from './syndication-state';
import { firstFocusable, h, icon, noteHref, popover, toast, uid } from './ui';

type YamlModule = typeof import('yaml');
type Part = HTMLElement | null;

/** the note this page shows, and its unit once the first read names it */
interface NotePage {
  noteId: string;
  unit: string | null;
  /** reads every peer's status of a note */
  read: (note: string) => Promise<void>;
}

/* ---------------- standing ---------------- */

/** everything a chip, a popover or an overview row tells apart about one
 *  unit on one peer */
export type Standing = CopyState | 'pending' | 'rejected' | 'refused' | 'unreachable' | 'unsettled';

/** what the peer's answer says, unless this page knows better: a publish
 *  the peer already holds is pending, and an attempt of this page that has
 *  not shown its ending is unsettled until an answer shows it */
function standingOf(sync: PeerSync, unit: string, status: SyndicationUnitStatus): Standing {
  if (sync.job(unit)?.submitted) return 'pending';
  if (sync.unsettled(unit) && status.submission?.state !== 'pending') return 'unsettled';
  if (status.state !== 'ready' || !status.copy) return 'unreachable';
  if (status.submission) return status.submission.state;
  if (status.refusals?.length) return 'refused';
  return status.copy;
}

function rowStandingOf(sync: PeerSync, row: SyndicationOverviewCopy): Standing {
  if (sync.job(row.unit)?.submitted) return 'pending';
  if (sync.unsettled(row.unit) && row.submission?.state !== 'pending') return 'unsettled';
  return row.submission?.state ?? row.copy;
}

/** the dot vocabulary shared with the share chip (wiki.css `.wiki-dot`) */
const DOTS: Record<Standing, 'current' | 'stale' | 'checking' | 'conflict' | 'off' | null> = {
  absent: null,
  current: 'current',
  behind: 'stale',
  pending: 'checking',
  changed: 'conflict',
  occupied: 'conflict',
  foreign: 'conflict',
  rejected: 'conflict',
  refused: 'off',
  unreachable: 'off',
  unsettled: 'checking',
};

/** a running or queued operation shows as checking, whatever the status says */
function setDot(el: HTMLElement, standing: Standing | null, job: Job | null): void {
  const state = job ? 'checking' : standing ? DOTS[standing] : null;
  el.hidden = !state;
  if (state) el.dataset['state'] = state;
  else delete el.dataset['state'];
}

function dot(standing: Standing | null, job: Job | null = null): HTMLElement {
  const el = h('span', { class: 'wiki-dot', 'aria-hidden': 'true' });
  setDot(el, standing, job);
  return el;
}

/** a copy of this unit exists on the peer */
function hasCopy(copy: CopyState | null): boolean {
  return copy === 'current' || copy === 'behind' || copy === 'changed';
}

/* ---------------- wording ---------------- */

/** a failure in the page's language: a code or an HTTP status says what
 *  happened; the server's own line is added only where it is a tool's
 *  output (git's error, a validator's finding) */
function failureText(failure: Failure, peer: string): string {
  if (failure.code) return S.sync.error[failure.code](peer, failure.message);
  return S.sync.http(failure.http, failure.message);
}

function refusalText(refusal: SyndicationRefusal): string {
  if (refusal.code === 'frontmatter') return S.sync.refusal.frontmatter(refusal.note, refusal.detail);
  if (refusal.code === 'degrade') return S.sync.refusal.degrade(refusal.note, refusal.target);
  return S.sync.refusal[refusal.code](refusal.note);
}

/** the line a running operation shows */
function jobLine(job: Job | null, peer: string): string {
  if (job?.state !== 'running') return '';
  return job.progress ? S.sync.stage[job.progress.stage](peer, job.progress.seconds) : S.sync.starting[job.action];
}

/** the toast of an operation's end */
function outcomeToast(attempt: Attempt, peer: string): [string, 'ok' | 'err'] {
  if (attempt.failure && attempt.outcome !== 'unknown') return [failureText(attempt.failure, peer), 'err'];
  return [S.sync.outcome[attempt.action][attempt.outcome](peer), attempt.outcome === 'rejected' ? 'err' : 'ok'];
}

/* ---------------- helpers ---------------- */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** a frontmatter value as one line of plain text */
function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.map(fieldText).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** only an absolute http(s) address becomes a link */
function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function hint(text: string, tone?: 'alert'): HTMLElement {
  return h('div', { class: tone ? 'wiki-sync-hint wiki-sync-alert' : 'wiki-sync-hint' }, text);
}

/** the textarea's overrides, `null` for none, or the message to show instead */
function parseOverrides(yaml: YamlModule, text: string): Record<string, unknown> | null | string {
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = yaml.parse(text);
  } catch (err) {
    return S.sync.overrides.invalid(err instanceof Error ? err.message : String(err));
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return S.sync.overrides.notMap;
  return value as Record<string, unknown>;
}

/** the control a view hands focus to: an open question's answer (or the
 *  control that asked it), else a marked action, else its first control */
function preferredFocus(root: HTMLElement): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('[data-sync-focus="answer"]') ??
    root.querySelector<HTMLElement>('[data-sync-focus]') ??
    firstFocusable(root)
  );
}

/** focus inside `target` moves to its dialog, so replacing the content
 *  never drops it to the page; returns whether it was inside */
function parkFocus(target: HTMLElement): boolean {
  if (!target.contains(document.activeElement)) return false;
  target.closest<HTMLElement>('.wiki-popover')?.focus();
  return true;
}

/* ---------------- across a reload ---------------- */

/** a saved classification rewrites the note and the page reloads: the
 *  popover comes back open, and the save is told, on the reloaded page */
interface Reopen {
  note: string;
  peer: string;
  /** epoch ms of the save */
  at: number;
}

const REOPEN_KEY = 'wiki:syndication:reopen';
/** a reload later than this is not the save's */
const REOPEN_MS = 30_000;

/** storage can be off or full: the popover then just stays closed */
function remember(value: Reopen | null): void {
  try {
    if (value) sessionStorage.setItem(REOPEN_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(REOPEN_KEY);
  } catch {
    // nothing to reopen
  }
}

/** the peer to reopen for this note, taken once */
function recall(note: string): string | null {
  let value: Partial<Reopen> | null = null;
  try {
    value = JSON.parse(sessionStorage.getItem(REOPEN_KEY) ?? 'null') as Partial<Reopen> | null;
    sessionStorage.removeItem(REOPEN_KEY);
  } catch {
    return null;
  }
  const fresh = typeof value?.at === 'number' && Date.now() - value.at < REOPEN_MS;
  return value?.note === note && fresh && typeof value.peer === 'string' ? value.peer : null;
}

/* ---------------- note view ---------------- */

/** the overrides editor's text and fold, kept across re-renders of one popover */
interface OverridesDraft {
  open: boolean;
  /** null = the overrides as the server has them */
  text: string | null;
}

/** what the note view acts with */
interface NoteCtx {
  sync: PeerSync;
  page: NotePage;
  unit: string;
  peer: string;
  /** no operation runs or waits for the unit: actions are offered */
  idle: boolean;
  draft: OverridesDraft;
}

/** a button that asks before it acts: the question and the two answers
 *  take its place while the unit's open question is this one — kept in the
 *  PeerSync, so a re-render keeps it open; Cancel brings the button back */
function confirmAction(
  ctx: NoteCtx,
  opts: { key: string; label: string; question: string; confirm: string; primary?: boolean; run: () => void },
): Part {
  if (!ctx.idle) return null;
  const open = ctx.sync.confirm(ctx.unit);
  if (open?.key === opts.key && open.asking) {
    return h(
      'div',
      { class: 'wiki-sync-confirm' },
      hint(opts.question),
      h(
        'div',
        { class: 'wiki-sync-actions' },
        h('button', { type: 'button', class: 'wiki-btn wiki-btn-danger', 'data-sync-focus': 'answer', onclick: opts.run }, opts.confirm),
        h('button', { type: 'button', class: 'wiki-btn', onclick: () => ctx.sync.unask(ctx.unit) }, S.sync.cancel),
      ),
    );
  }
  const focus = open?.key === opts.key ? 'answer' : opts.primary ? '' : null;
  return h(
    'div',
    { class: 'wiki-sync-confirm' },
    h(
      'button',
      {
        type: 'button',
        class: opts.primary ? 'wiki-btn wiki-btn-primary' : 'wiki-btn',
        ...(focus === null ? {} : { 'data-sync-focus': focus }),
        onclick: () => ctx.sync.ask(ctx.unit, opts.key),
      },
      opts.label,
    ),
  );
}

function publishButton(ctx: NoteCtx, label: string, options: { adopt?: boolean; force?: boolean }): Part {
  if (!ctx.idle) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'wiki-btn wiki-btn-primary',
      'data-sync-focus': '',
      onclick: () => ctx.sync.publish(ctx.unit, { note: ctx.page.noteId, ...options }),
    },
    label,
  );
}

function confirmedPublish(ctx: NoteCtx, label: string, question: string, options: { adopt?: boolean; force?: boolean }): Part {
  return confirmAction(ctx, {
    key: options.adopt ? 'adopt' : 'overwrite',
    label,
    question,
    confirm: label,
    primary: true,
    run: () => ctx.sync.publish(ctx.unit, { note: ctx.page.noteId, ...options }),
  });
}

function withdrawAction(ctx: NoteCtx, copy: CopyState | null): Part {
  const force = copy === 'changed';
  return confirmAction(ctx, {
    key: 'withdraw',
    label: S.sync.withdraw,
    question: force ? S.sync.withdrawChangedConfirm(ctx.peer) : S.sync.withdrawConfirm(ctx.peer),
    confirm: S.sync.withdraw,
    run: () => ctx.sync.withdraw(ctx.unit, ctx.page.noteId, force),
  });
}

/** when the copy was received, and a link to it */
function copyFacts(status: SyndicationUnitStatus): Part {
  const href = safeUrl(status.copyUrl);
  if (!status.synced && !href) return null;
  return h(
    'div',
    { class: 'wiki-sync-facts' },
    status.synced ? h('span', {}, S.sync.synced(formatDate(status.synced))) : null,
    href ? h('a', { class: 'wiki-sync-link', href, target: '_blank', rel: 'noopener' }, S.sync.openCopy) : null,
  );
}

function problemsBlock(title: string, problems: string[]): HTMLElement {
  const id = uid('sync-problems');
  return h(
    'div',
    { class: 'wiki-sync-block' },
    h('div', { id, class: 'wiki-sync-hint wiki-sync-alert' }, title),
    // a scrolling region is reachable by keyboard
    h(
      'ul',
      { class: 'wiki-sync-problems', tabindex: '0', 'aria-labelledby': id },
      ...problems.map((problem) => h('li', {}, problem)),
    ),
  );
}

/** what publishing would send: sizes, links that turn into text, warnings */
function planSection(plan: SyndicationPlan | undefined, peer: string): Part[] {
  if (!plan) return [];
  return [
    hint(S.sync.planSummary(plan.notes, plan.files, formatBytes(plan.bytes))),
    plan.degraded.length
      ? h(
          'details',
          { class: 'wiki-sync-fold' },
          h('summary', {}, S.sync.degraded(plan.degraded.length, peer)),
          h(
            'ul',
            { class: 'wiki-sync-list' },
            ...plan.degraded.map((link) =>
              h(
                'li',
                {},
                h('code', { class: 'wiki-sync-mono' }, link.target),
                link.shown !== link.target ? ` → ${link.shown}` : null,
                h('span', { class: 'wiki-sync-where' }, ` · ${S.sync.degradedIn(link.note)}`),
              ),
            ),
          ),
        )
      : null,
    ...plan.warnings.map((warning) =>
      h('div', { class: 'wiki-sync-warning' }, S.sync.warning[warning.kind](warning.url, warning.note, peer)),
    ),
  ];
}

/** the latest attempt's own failure — told apart from any earlier verdict of
 *  the peer by its time; a rejection the status already shows is not repeated */
function attemptBlock(attempt: Attempt | null, status: SyndicationUnitStatus, peer: string): Part {
  const failure = attempt?.failure;
  // a submission whose answer went missing is still open, not failed
  if (!attempt || !failure || attempt.outcome === 'unknown') return null;
  if (failure.code === 'rejected' && status.submission?.state === 'rejected') return null;
  const title = S.sync.attemptFailed[attempt.action](formatDate(attempt.at), failureText(failure, peer));
  return failure.problems.length ? problemsBlock(title, failure.problems) : hint(title, 'alert');
}

/** the explanation and actions of the unit's standing */
function standingBody(ctx: NoteCtx, status: SyndicationUnitStatus, standing: Standing): Part[] {
  const { peer } = ctx;
  switch (standing) {
    case 'unreachable':
      return [
        hint(S.sync.unreachableExplain(peer)),
        status.error ? h('div', { class: 'wiki-sync-errline wiki-sync-mono' }, status.error) : null,
        ctx.sync.unresolved(ctx.unit) ? hint(S.sync.stillOpen(peer)) : null,
      ];
    case 'unsettled':
      return [
        hint(S.sync.unsettledExplain[ctx.sync.attempt(ctx.unit)?.action === 'withdraw' ? 'withdraw' : 'publish'](peer)),
        status.state !== 'ready' && status.error ? h('div', { class: 'wiki-sync-errline wiki-sync-mono' }, status.error) : null,
        copyFacts(status),
      ];
    case 'pending':
      return [
        hint(S.sync.pendingExplain(formatDate(status.submission?.at ?? ctx.sync.job(ctx.unit)?.submitted?.at ?? Date.now()))),
        copyFacts(status),
        hasCopy(status.copy) ? h('button', { type: 'button', class: 'wiki-btn', disabled: true }, S.sync.withdraw) : null,
      ];
    case 'rejected': {
      const submission = status.submission!;
      const at = formatDate(submission.at);
      return [
        hint(submission.action === 'withdraw' ? S.sync.rejectedWithdraw(peer, at) : S.sync.rejectedExplain(peer, at)),
        submission.code ? hint(S.sync.error[submission.code](peer, '')) : null,
        submission.problems?.length ? problemsBlock(S.sync.problemsFound, submission.problems) : null,
        ...standingBody(ctx, status, status.refusals?.length ? 'refused' : status.copy!),
      ];
    }
    case 'refused':
      return [
        h(
          'div',
          { class: 'wiki-sync-block' },
          hint(S.sync.refusedTitle, 'alert'),
          h('ul', { class: 'wiki-sync-list' }, ...(status.refusals ?? []).map((refusal) => h('li', {}, refusalText(refusal)))),
        ),
        ...(hasCopy(status.copy) ? [copyFacts(status), withdrawAction(ctx, status.copy)] : []),
      ];
    case 'absent':
      return [...planSection(status.plan, peer), publishButton(ctx, S.sync.publish(peer), {})];
    case 'occupied':
      return [
        hint(S.sync.occupiedExplain(peer)),
        ...planSection(status.plan, peer),
        confirmedPublish(ctx, S.sync.adopt, S.sync.adoptConfirm(peer), { adopt: true }),
      ];
    case 'foreign':
      return [hint(S.sync.foreignExplain(peer))];
    case 'current':
      return [copyFacts(status), withdrawAction(ctx, status.copy)];
    case 'behind':
      return [
        hint(
          S.sync.behindExplain(
            status.synced ? formatDate(status.synced) : '—',
            status.sourceChangedAt ? formatDate(status.sourceChangedAt) : null,
          ),
        ),
        copyFacts(status),
        ...planSection(status.plan, peer),
        publishButton(ctx, S.sync.publishAgain, {}),
        withdrawAction(ctx, status.copy),
      ];
    case 'changed':
      return [
        hint(S.sync.changedExplain),
        status.behind ? hint(S.sync.changedBehind) : null,
        copyFacts(status),
        ...planSection(status.plan, peer),
        confirmedPublish(ctx, S.sync.overwrite, S.sync.overwriteConfirm(peer), { force: true }),
        withdrawAction(ctx, status.copy),
      ];
  }
}

/** the unit root's classification in the copy, and — while the unit is idle —
 *  the fold that edits this peer's overrides of it (YAML; the parser loads
 *  when the fold first opens) */
function classification(ctx: NoteCtx, plan: SyndicationPlan): HTMLElement {
  const entries = Object.entries(plan.fields);
  return h(
    'div',
    { class: 'wiki-sync-block' },
    entries.length
      ? h(
          'div',
          { class: 'wiki-sync-fields' },
          h('div', { class: 'wiki-form-label' }, S.sync.classification),
          h('dl', {}, ...entries.map(([key, value]) => h('div', {}, h('dt', {}, key), h('dd', {}, fieldText(value))))),
        )
      : null,
    ctx.idle ? overridesFold(ctx, plan) : null,
  );
}

function overridesFold(ctx: NoteCtx, plan: SyndicationPlan): HTMLElement {
  const { draft } = ctx;
  const areaId = uid('sync-overrides');
  const hintId = uid('sync-overrides-hint');
  const area = h('textarea', {
    id: areaId,
    class: 'wiki-textarea wiki-sync-yaml',
    rows: 4,
    spellcheck: false,
    disabled: true,
    'aria-describedby': hintId,
  });
  const save = h('button', { type: 'submit', class: 'wiki-btn', disabled: true }, S.sync.overrides.save);
  let yaml: YamlModule | null = null;

  const load = async (): Promise<void> => {
    try {
      yaml = await import('yaml');
    } catch {
      toast(S.sync.overrides.loadFailed, 'err');
      return;
    }
    area.value = draft.text ?? (plan.overrides ? yaml.stringify(plan.overrides) : '');
    area.placeholder = Object.keys(plan.fields).length ? yaml.stringify(plan.fields) : '';
    area.disabled = false;
    save.disabled = false;
  };
  const submit = async (): Promise<void> => {
    if (!yaml) return;
    const fields = parseOverrides(yaml, area.value);
    if (typeof fields === 'string') {
      toast(fields, 'err');
      return;
    }
    // saving rewrites the note, and the dev server reloads the page for it
    remember({ note: ctx.page.noteId, peer: ctx.sync.peer.id, at: Date.now() });
    if ((await ctx.sync.saveOverrides(ctx.unit, ctx.page.noteId, fields)) === 'accepted') {
      draft.text = null;
      setTimeout(() => remember(null), REOPEN_MS);
    } else remember(null);
  };
  area.addEventListener('input', () => {
    draft.text = area.value;
  });

  const fold = h(
    'details',
    { class: 'wiki-sync-fold', open: draft.open },
    h('summary', {}, S.sync.overrides.fold),
    h(
      'form',
      {
        class: 'wiki-sync-overrides',
        onsubmit: (e: Event) => {
          e.preventDefault();
          void submit();
        },
      },
      h('div', { id: hintId, class: 'wiki-sync-hint' }, S.sync.overrides.hint(ctx.peer)),
      h('label', { class: 'wiki-form-label', for: areaId }, S.sync.overrides.label),
      area,
      save,
    ),
  );
  fold.addEventListener('toggle', () => {
    draft.open = fold.open;
    if (fold.open && !yaml) void load();
  });
  if (draft.open) void load();
  return fold;
}

function headline(status: SyndicationUnitStatus, standing: Standing, peer: string): string {
  if (standing === 'pending' && status.submission?.action === 'withdraw') return S.sync.pendingWithdraw(peer);
  return S.sync.standing[standing](peer);
}

/** a unit waiting in the overview's queue: said so, with the way out */
function queuedBlock(ctx: NoteCtx): HTMLElement {
  return h(
    'div',
    { class: 'wiki-sync-block' },
    hint(S.sync.queued),
    h(
      'button',
      { type: 'button', class: 'wiki-btn', 'data-sync-focus': '', onclick: () => ctx.sync.dequeue(ctx.unit) },
      S.sync.dequeue,
    ),
  );
}

function noteView(sync: PeerSync, page: NotePage, draft: OverridesDraft, openOverview: () => void): HTMLElement {
  const peer = sync.peer.title;
  const title = h('div', { class: 'wiki-panel-title' }, S.sync.title(peer));
  const status = page.unit ? sync.status(page.unit) : null;
  if (!page.unit || !status) return h('div', { class: 'wiki-sync-panel' }, title, hint(S.sync.loading));
  const job = sync.job(page.unit);
  const ctx: NoteCtx = { sync, page, unit: page.unit, peer, idle: !job && !sync.unresolved(page.unit), draft };
  const standing = standingOf(sync, page.unit, status);
  const editable = !['pending', 'foreign', 'unreachable', 'unsettled'].includes(standing);
  const count = sync.overview().length;
  return h(
    'div',
    { class: 'wiki-sync-panel' },
    title,
    h('div', { class: 'wiki-sync-standing' }, dot(standing, job), h('span', {}, headline(status, standing, peer))),
    status.unit !== page.noteId ? hint(S.sync.together(status.unit)) : null,
    job?.state === 'queued' ? queuedBlock(ctx) : null,
    attemptBlock(sync.attempt(page.unit), status, peer),
    ...standingBody(ctx, status, standing),
    editable && status.plan ? classification(ctx, status.plan) : null,
    status.state === 'ready'
      ? h(
          'div',
          { class: 'wiki-sync-footer' },
          h(
            'button',
            { type: 'button', class: 'wiki-sync-linkbtn', 'data-sync-count': '', onclick: openOverview },
            S.sync.overview.link(sync.overviewRead() ? count : null),
          ),
        )
      : null,
  );
}

/* ---------------- overview ---------------- */

/** publish-all takes it: behind here, present here, nothing running, waiting
 *  or undecided for it */
function publishable(sync: PeerSync, row: SyndicationOverviewCopy): boolean {
  return row.copy === 'behind' && !row.missing && !sync.unresolved(row.unit) && row.submission?.state !== 'pending' && !sync.job(row.unit);
}

/** one row's content: dot, title, state, and what the unit's own operation
 *  says — its progress, its place in the queue, or its failure's findings */
function rowContent(sync: PeerSync, row: SyndicationOverviewCopy): HTMLElement[] {
  const peer = sync.peer.title;
  const job = sync.job(row.unit);
  const attempt = sync.attempt(row.unit);
  const standing = rowStandingOf(sync, row);
  const href = safeUrl(row.copyUrl);
  const running = jobLine(job, peer);
  const failure = !job && attempt?.failure && attempt.outcome !== 'unknown' ? attempt.failure : null;
  const verdict = row.submission?.state === 'rejected' ? (row.submission.problems ?? []) : [];
  const findingsId = uid('sync-row-findings');
  return [
    dot(standing, job),
    h(
      'div',
      { class: 'wiki-sync-row-main' },
      row.missing
        ? h('span', { class: 'wiki-sync-row-title' }, row.title)
        : h('a', { class: 'wiki-sync-row-title', href: noteHref(row.unit) }, row.title),
      h(
        'div',
        { class: 'wiki-sync-row-meta' },
        h('span', {}, job?.state === 'queued' ? S.sync.rowQueued : S.sync.rowState[standing]),
        row.synced ? h('span', {}, formatDate(row.synced, 'date')) : null,
        row.missing ? h('span', { class: 'wiki-sync-alert' }, S.sync.overview.missing) : null,
        href ? h('a', { class: 'wiki-sync-link', href, target: '_blank', rel: 'noopener' }, S.sync.openCopy) : null,
      ),
      running ? h('div', { class: 'wiki-sync-row-note' }, running) : null,
      failure
        ? h(
            'div',
            { class: 'wiki-sync-row-note' },
            h('div', { id: findingsId, class: 'wiki-sync-alert' }, failureText(failure, peer)),
            failure.problems.length
              ? h(
                  'ul',
                  { class: 'wiki-sync-problems', tabindex: '0', 'aria-labelledby': findingsId },
                  ...failure.problems.map((problem) => h('li', {}, problem)),
                )
              : null,
          )
        : null,
      !failure && verdict.length
        ? h(
            'details',
            { class: 'wiki-sync-fold wiki-sync-row-note' },
            h('summary', {}, S.sync.problemsCount(verdict.length)),
            h('ul', { class: 'wiki-sync-problems', tabindex: '0' }, ...verdict.map((problem) => h('li', {}, problem))),
          )
        : null,
    ),
    job?.state === 'queued'
      ? h(
          'button',
          {
            type: 'button',
            class: 'wiki-btn wiki-sync-rowbtn',
            'aria-label': `${S.sync.dequeue} · ${row.title}`,
            onclick: () => sync.dequeue(row.unit),
          },
          S.sync.dequeue,
        )
      : publishable(sync, row)
        ? h(
            'button',
            {
              type: 'button',
              class: 'wiki-btn wiki-sync-rowbtn',
              'aria-label': `${S.sync.overview.publish} · ${row.title}`,
              onclick: () => sync.enqueue([row.unit]),
            },
            S.sync.overview.publish,
          )
        : null,
  ].filter((part): part is HTMLElement => part !== null);
}

interface OverviewView {
  el: HTMLElement;
  /** redraw one unit's row and the publish-all count */
  update: (unit: string) => void;
  /** the rows' units and the error the view was built with — an overview
   *  read that changes either rebuilds it */
  key: string;
}

function overviewKey(sync: PeerSync): string {
  return `${sync.overview().map((row) => row.unit).join('\n')}\0${sync.overviewError() ?? ''}`;
}

function overviewView(sync: PeerSync, back: () => void): OverviewView {
  const peer = sync.peer.title;
  const failure = sync.overviewError();
  const error = failure === null ? null : S.sync.error.unreachable(peer, failure);
  const rows = new Map<string, HTMLElement>();
  const all = h('button', { type: 'button', class: 'wiki-btn wiki-btn-primary' });
  all.addEventListener('click', () => sync.enqueue(sync.overview().filter((row) => publishable(sync, row)).map((row) => row.unit)));
  const footer = h(
    'div',
    { class: 'wiki-sync-footer' },
    h('button', { type: 'button', class: 'wiki-sync-linkbtn', 'data-sync-focus': '', onclick: back }, S.sync.overview.back),
  );
  /** the button hides when nothing is left to publish; focus on it moves on */
  const countBehind = (): void => {
    const count = sync.overview().filter((row) => publishable(sync, row)).length;
    const parked = count === 0 && parkFocus(all);
    all.textContent = S.sync.overview.publishAll(count);
    all.hidden = count === 0;
    all.toggleAttribute('data-sync-focus', count > 0);
    if (parked) preferredFocus(footer)?.focus();
  };
  const list = h('ul', { class: 'wiki-sync-rows' });
  for (const row of sync.overview()) {
    const li = h('li', { class: 'wiki-sync-row' }, ...rowContent(sync, row));
    rows.set(row.unit, li);
    list.append(li);
  }
  countBehind();
  const el = h(
    'div',
    { class: 'wiki-sync-panel' },
    h('div', { class: 'wiki-panel-title' }, S.sync.overview.title(peer)),
    error ? hint(error, 'alert') : null,
    rows.size ? list : error ? null : hint(S.sync.overview.empty),
    all,
    footer,
  );
  return {
    el,
    key: overviewKey(sync),
    update: (unit) => {
      const li = rows.get(unit);
      const row = sync.overview().find((candidate) => candidate.unit === unit);
      if (li && row) {
        const parked = parkFocus(li);
        li.replaceChildren(...rowContent(sync, row));
        if (parked) preferredFocus(li)?.focus();
      }
      countBehind();
    },
  };
}

/* ---------------- popovers ---------------- */

/**
 * The peer popover: the note view, or the overview in its place. It follows
 * the PeerSync while open and watches it, so unresolved submissions are
 * re-read; the status line below the view announces the running
 * operation — in the overview, each unit and stage once.
 */
function openPeerPopover(anchor: HTMLElement, page: NotePage, sync: PeerSync, classificationOpen = false): void {
  const peer = sync.peer.title;
  const view = h('div', { class: 'wiki-sync-view' });
  const line = h('div', { class: 'wiki-sync-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'wiki-sync-body' }, view, line);
  const draft: OverridesDraft = { open: classificationOpen, text: null };
  let mode: 'note' | 'overview' = 'note';
  let overview: OverviewView | null = null;
  let spoken = '';

  /** focus in the view or on the dialog goes to the new view's preferred
   *  control — or stays on the dialog while an operation runs */
  const render = (el: HTMLElement, busy = false): void => {
    const dialog = view.closest<HTMLElement>('.wiki-popover');
    const held = parkFocus(view) || (dialog !== null && document.activeElement === dialog);
    view.replaceChildren(el);
    if (held && !busy) preferredFocus(view)?.focus();
  };
  const showNote = (): void => {
    mode = 'note';
    overview = null;
    const job = page.unit ? sync.job(page.unit) : null;
    line.textContent = jobLine(job, peer);
    render(noteView(sync, page, draft, showOverview), job?.state === 'running');
  };
  const showError = (err: unknown): void => {
    render(hint(failureText(failureOf(err), peer), 'alert'));
  };
  /** (re)build the overview when its rows or its error changed */
  const showRows = (): void => {
    if (overview?.key === overviewKey(sync)) return;
    overview = overviewView(sync, backToNote);
    render(overview.el);
  };
  /** the overview's live line: the unit running and its stage, said once each */
  const speak = (unit: string): void => {
    const job = sync.job(unit);
    if (job?.state !== 'running') return;
    const key = `${unit}\0${job.progress?.stage ?? ''}`;
    if (key === spoken) return;
    spoken = key;
    const title = sync.overview().find((row) => row.unit === unit)?.title ?? unit;
    line.textContent = S.sync.overview.progress(title, jobLine(job, peer));
  };
  const backToNote = (): void => {
    showNote();
    void page.read(page.noteId).catch(() => {});
  };
  function showOverview(): void {
    mode = 'overview';
    overview = null;
    spoken = '';
    line.textContent = '';
    render(hint(S.sync.loading));
    sync.readOverview().catch((err: unknown) => {
      if (mode === 'overview' && !overview) showError(err);
    });
  }

  const unsubscribe = sync.subscribe((event) => {
    if (event.kind === 'settled') {
      // the list's count may have changed
      void sync.readOverview().catch(() => {});
      return;
    }
    if (mode === 'overview') {
      if (event.kind === 'overview') showRows();
      else if (event.kind === 'drained') {
        spoken = '';
        line.textContent = '';
      } else {
        overview?.update(event.unit);
        speak(event.unit);
      }
      return;
    }
    if (event.kind === 'overview') {
      const link = view.querySelector('[data-sync-count]');
      if (link) link.textContent = S.sync.overview.link(sync.overviewRead() ? sync.overview().length : null);
      return;
    }
    if (event.kind === 'drained' || event.unit !== page.unit) return;
    if (event.kind === 'progress') line.textContent = jobLine(sync.job(event.unit), peer);
    else showNote();
  });
  const unwatch = sync.watch();
  popover(anchor, body, {
    label: S.sync.title(peer),
    onClose: () => {
      unsubscribe();
      unwatch();
    },
  });
  showNote();
  void sync.readOverview().catch(() => {});
  page.read(page.noteId).catch((err: unknown) => {
    if (mode === 'note' && !(page.unit && sync.status(page.unit))) showError(err);
  });
}

function copyNotice(origin: CopyOrigin): HTMLElement {
  return h(
    'div',
    { class: 'wiki-sync-panel' },
    h('div', { class: 'wiki-panel-title' }, S.sync.copy.chip(origin.wiki)),
    hint(S.sync.copy.notice(origin.wiki)),
    h(
      'div',
      { class: 'wiki-sync-facts' },
      h('span', {}, S.sync.synced(formatDate(origin.synced))),
      h('span', {}, `${S.sync.copy.revision} `, h('code', { class: 'wiki-sync-mono' }, origin.revision)),
    ),
  );
}

/* ---------------- chips ---------------- */

function copyChip(origin: CopyOrigin): HTMLElement {
  const label = S.sync.copy.chip(origin.wiki);
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'wiki-chip wiki-sync-chip',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: () => popover(chip, copyNotice(origin), { label }),
    },
    icon('sync'),
    h('span', { class: 'wiki-chip-name' }, label),
  );
  return chip;
}

/** the peer's chip: its dot and title follow the note's unit there — the
 *  running or queued operation first, then the last status read */
function peerChip(page: NotePage, sync: PeerSync): HTMLElement {
  const peer = sync.peer.title;
  const mark = dot(null);
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: 'wiki-chip wiki-sync-chip',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: () => openPeerPopover(chip, page, sync),
    },
    icon('sync'),
    h('span', { class: 'wiki-chip-name' }, peer),
    mark,
  );
  const reflect = (): void => {
    const status = page.unit ? sync.status(page.unit) : null;
    const job = page.unit ? sync.job(page.unit) : null;
    const standing = status && page.unit ? standingOf(sync, page.unit, status) : null;
    setDot(mark, standing, job);
    const running = jobLine(job, peer);
    const state = job?.state === 'queued' ? S.sync.rowQueued : running || (standing ? S.sync.rowState[standing] : null);
    chip.title = running || (standing ? S.sync.standing[standing](peer) : S.sync.title(peer));
    chip.setAttribute('aria-label', state ? `${S.sync.title(peer)} · ${state}` : S.sync.title(peer));
  };
  reflect();
  sync.subscribe((event) => {
    if ((event.kind === 'changed' || event.kind === 'progress') && event.unit === page.unit) reflect();
  });
  return chip;
}

/** every ending is told once, whichever view started it — a queue's
 *  operations together when it runs empty */
function announce(sync: PeerSync): void {
  const peer = sync.peer.title;
  sync.subscribe((event) => {
    if (event.kind === 'settled' && !event.queued) {
      const [text, tone] = outcomeToast(event.attempt, peer);
      toast(text, tone);
    } else if (event.kind === 'drained') {
      const { accepted, pending, rejected, failed, unknown } = event.tally;
      toast(S.sync.overview.done(accepted, pending + unknown, rejected + failed), rejected + failed ? 'err' : 'ok');
    }
  });
}

/* ---------------- mount ---------------- */

/** Note pages only (index.ts calls this after meta resolves). Mounts nothing
 *  when the site declares no slot, or when the note is no copy and no peer
 *  is configured. */
export function mountSyndication(pageCtx: PageContext): void {
  const slot = document.querySelector('[data-inkbrush-slot="share"]');
  if (!slot) return;
  const { meta } = pageCtx;
  if (meta.origin) {
    slot.append(h('span', { class: 'wiki-sync-slot' }, copyChip(meta.origin)));
    return;
  }
  const peers = syndicationPeers();
  if (peers.length === 0) return;

  const syncs: PeerSync[] = [];
  const page: NotePage = {
    noteId: meta.id,
    unit: null,
    read: async (note) => {
      const tickets = syncs.map((sync) => sync.beginRead());
      const { unit, peers: statuses } = await api.get<SyndicationNoteResponse>(`/syndication?note=${encodeURIComponent(note)}`);
      if (note === page.noteId) page.unit = unit;
      syncs.forEach((sync, index) => {
        const status = statuses.find((candidate) => candidate.peer.id === sync.peer.id);
        if (status) sync.offerStatus(status, tickets[index]!);
      });
    },
  };
  for (const peer of peers) {
    const sync = new PeerSync(peer, page.read);
    announce(sync);
    syncs.push(sync);
  }

  const chips = syncs.map((sync) => peerChip(page, sync));
  const holder = h('span', { class: 'wiki-sync-slot' }, ...chips);
  // signed-in users only — follow login/logout live
  const follow = (): Promise<void> => {
    holder.hidden = !currentUser();
    return currentUser() ? page.read(page.noteId).catch(() => {}) : Promise.resolve();
  };
  const first = follow();
  onAuthChange(() => void follow());
  slot.append(holder);

  const reopen = recall(page.noteId);
  const index = syncs.findIndex((sync) => sync.peer.id === reopen);
  if (index >= 0 && currentUser()) {
    void first.then(() => {
      openPeerPopover(chips[index]!, page, syncs[index]!, true);
      toast(S.sync.outcome.overrides.accepted(syncs[index]!.peer.title));
    });
  }
}
