/**
 * Syndication state of one note page, per peer — the one place the chips,
 * the note popover and the overview read from and act through, so an
 * operation started in any of them is seen and respected by all of them.
 *
 * A PeerSync keeps, per unit: the latest status read and the latest overview
 * row; the operation that runs or waits in the queue; the latest attempt's
 * outcome and findings; an open confirmation; and whether a submission is
 * unresolved.
 *
 * Operations on one unit are exclusive. The overview's publishes wait in one
 * queue per peer and run one unit at a time; a unit in the queue, or with an
 * unresolved submission, takes no other operation.
 *
 * Reads are numbered as they start. A read's answer about a unit applies
 * only when it started after the read last applied to that unit, and after
 * the unit's last operation ended; an overview answer applies at all only
 * when it is the newest overview answer so far. A slow answer therefore
 * never overwrites a newer one or an operation's result, re-adds a removed
 * row, or brings back an old error.
 *
 * A publish or withdraw of this page is known by the commit it staged: the
 * one the stream's `submitted` event names, fixed from then on, or else the
 * first submission an answer read after the attempt started shows that is
 * not the one shown before it. An answer settles the attempt when the peer
 * names that commit rejected, or when — nothing pending — the copy carries
 * the submitted revision (publish) or is gone (withdraw). An answer read more
 * than the server's fetch freshness after the attempt ended that settles
 * nothing ends it too: without a known commit it was not submitted, with one
 * it was overtaken.
 * Unresolved submissions are re-read every 15 s, one poll at a time: this
 * page's own always, every other one while a view watches.
 *
 * DOM-free: listeners turn events into views and toasts.
 */
import type {
  SyndicationActionResponse,
  SyndicationErrorCode,
  SyndicationOverviewCopy,
  SyndicationOverviewResponse,
  SyndicationPeerInfo,
  SyndicationPublishRequest,
  SyndicationStage,
  SyndicationStreamEvent,
  SyndicationSubmission,
  SyndicationUnitStatus,
} from '../shared/types';
import { api, ApiError, stream } from './api';

/* ---------------- failures and outcomes ---------------- */

/** why a request did not go through, however the server said it — a publish
 *  stream's error event, a JSON error body, or no answer at all */
export interface Failure {
  /** the server's code, when it gave one this client knows */
  code: SyndicationErrorCode | null;
  /** the HTTP status of an answer without a known code; 0 when no answer
   *  arrived (the network failed, or the stream broke off) */
  http: number;
  /** the server's own line (git's error for 'unreachable', a validator's
   *  finding for a 422) */
  message: string;
  /** checks' findings, one line each */
  problems: string[];
}

const ERROR_CODES: Record<SyndicationErrorCode, true> = {
  foreign: true,
  native: true,
  gone: true,
  moved: true,
  changed: true,
  'digest-mismatch': true,
  invalid: true,
  refused: true,
  busy: true,
  pending: true,
  rejected: true,
  unreachable: true,
};

function errorCode(value: unknown): SyndicationErrorCode | null {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value) ? (value as SyndicationErrorCode) : null;
}

/** a publish stream's error event, thrown */
class StreamFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

export function failureOf(err: unknown): Failure {
  if (err instanceof StreamFailure) return err.failure;
  if (err instanceof ApiError) {
    const problems = err.body['problems'];
    return {
      code: errorCode(err.body['code']),
      http: err.status,
      message: err.message,
      problems: Array.isArray(problems) ? problems.map(String) : [],
    };
  }
  return { code: null, http: 0, message: err instanceof Error ? err.message : String(err), problems: [] };
}

export type Action = 'publish' | 'withdraw' | 'overrides';

/**
 * How an operation ended:
 *   accepted — done: the peer took the copy or removed it, or the change is saved;
 *   pending  — submitted, the peer's checks have not decided yet;
 *   rejected — the peer's checks refused it;
 *   failed   — it did not go through;
 *   unknown  — it may have reached the peer; how it ended is not known yet.
 */
export type Outcome = 'accepted' | 'pending' | 'rejected' | 'failed' | 'unknown';

/** the latest operation on a unit and how it ended */
export interface Attempt {
  action: Action;
  outcome: Outcome;
  failure: Failure | null;
  /** epoch ms it ended */
  at: number;
}

/** where a running publish is */
export interface Progress {
  stage: SyndicationStage;
  /** seconds waited so far on the peer's checks */
  seconds?: number | undefined;
}

/** a submission the peer's repository holds */
export interface Submitted {
  commit: string;
  revision: string;
  /** epoch ms the peer took it */
  at: number;
}

export interface Job {
  action: Action;
  state: 'queued' | 'running';
  /** null until the first progress line (and for operations without one) */
  progress: Progress | null;
  /** set once a running publish reached the peer's repository */
  submitted: Submitted | null;
}

/** a publish or withdraw of this page, as its answers are matched to it */
interface Identity {
  action: 'publish' | 'withdraw';
  /** the submission's commit and the copy's revision shown before it started */
  before: { commit: string | null; revision: string | null };
  /** epoch ms it started */
  started: number;
  /** its staged commit; null while not known */
  commit: string | null;
  /** the revision it submitted (publish); null while not known */
  revision: string | null;
  /** epoch ms it ended: an answer read later than the server's fetch
   *  freshness after this would show it */
  since: number;
}

/** what an answer says about an attempt: decided, pending, overtaken, or
 *  nothing yet (null) */
type Verdict = Outcome | 'overtaken' | null;

/** a question an action asks before it acts; `asking` false once answered
 *  with no — the control that asked keeps the focus */
export interface Confirm {
  key: string;
  asking: boolean;
}

export type SyncEvent =
  /** the unit's status, row, job, attempt or confirmation changed */
  | { kind: 'changed'; unit: string }
  /** the unit's running publish moved on */
  | { kind: 'progress'; unit: string }
  /** an overview read arrived: rows may have come or gone, the error changed */
  | { kind: 'overview' }
  /** an operation ended, or an unresolved one of this page settled;
   *  `queued` when it ran from the overview's queue */
  | { kind: 'settled'; unit: string; attempt: Attempt; queued: boolean }
  /** the queue ran empty: how its operations ended */
  | { kind: 'drained'; tally: Record<Outcome, number> };

/** a read in flight: its number, how many operations had ended when it
 *  started, and when it started */
export interface ReadTicket {
  seq: number;
  ended: number;
  at: number;
}

const POLL_MS = 15_000;
/** how old the server's copy of the peer's repository may be when it answers */
const FRESHNESS_MS = 15_000;

/** what an answer shows about a unit, whichever read brought it */
interface Seen {
  copy: SyndicationUnitStatus['copy'];
  revision?: string | undefined;
  submission?: SyndicationSubmission | undefined;
}

/* ---------------- requests ---------------- */

interface PublishWatch {
  progress: (progress: Progress) => void;
  submitted: (commit: string, revision: string) => void;
}

/** publish one unit; the stream stays open while the peer's checks decide
 *  and answers with the unit's status — still pending when the wait ran out */
async function publishStream(peer: string, request: SyndicationPublishRequest, on: PublishWatch): Promise<SyndicationUnitStatus> {
  for await (const event of stream<SyndicationStreamEvent>(`/syndication/${encodeURIComponent(peer)}/publish`, request)) {
    if (event.kind === 'progress') on.progress({ stage: event.stage, seconds: event.seconds });
    else if (event.kind === 'submitted') on.submitted(event.commit, event.revision);
    else if (event.kind === 'result') return event.status;
    else throw new StreamFailure({ code: errorCode(event.code), http: 500, message: event.message, problems: event.problems ?? [] });
  }
  throw new StreamFailure({ code: null, http: 0, message: 'the stream ended without a result', problems: [] });
}

/** plain JSON values compare by content */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** an overview row brought up to date with a unit status read since */
function mergeRow(row: SyndicationOverviewCopy, status: SyndicationUnitStatus): SyndicationOverviewCopy {
  if (status.state !== 'ready' || !status.copy) return row;
  return {
    ...row,
    copy: status.copy,
    behind: status.behind,
    revision: status.revision,
    synced: status.synced,
    copyUrl: status.copyUrl,
    submission: status.submission,
  };
}

function hasCopy(copy: SyndicationUnitStatus['copy']): boolean {
  return copy === 'current' || copy === 'behind' || copy === 'changed';
}

/**
 * Match an answer to an attempt. A submission the answer shows becomes the
 * attempt's own only while the attempt knows none, when it differs from the
 * one shown before the attempt, and when the answer was read after the
 * attempt started. `late`: read long enough after the attempt ended to show
 * how it went.
 */
function judge(identity: Identity, seen: Seen, readAt: number, late: boolean): Verdict {
  const { submission } = seen;
  if (identity.commit === null && submission && submission.commit !== identity.before.commit && readAt >= identity.started) {
    identity.commit = submission.commit;
    identity.revision ??= submission.revision ?? null;
  }
  if (identity.commit !== null && submission?.commit === identity.commit) return submission.state;
  if (submission?.state === 'pending') return null;
  if (identity.action === 'withdraw') {
    if (seen.copy === 'absent') return 'accepted';
  } else if (hasCopy(seen.copy)) {
    // the submitted revision, or — the revision unknown — a revision other
    // than the one before
    const revision = seen.revision ?? null;
    if (identity.revision !== null ? revision === identity.revision : revision !== identity.before.revision) return 'accepted';
  }
  if (!late) return null;
  return identity.commit === null ? 'failed' : 'overtaken';
}

/** how a request that failed ended */
function failedOutcome(action: Action, failure: Failure, submitted: boolean): Outcome {
  if (failure.code === 'rejected') return 'rejected';
  if (submitted) return 'unknown';
  // no answer at all: the request may have reached the server
  return failure.http === 0 && action !== 'overrides' ? 'unknown' : 'failed';
}

/* ---------------- one peer ---------------- */

export class PeerSync {
  private readonly statuses = new Map<string, SyndicationUnitStatus>();
  private readonly rows = new Map<string, SyndicationOverviewCopy>();
  /** null until the first overview read */
  private rowOrder: string[] | null = null;
  /** git's line when the latest overview read could not reach the peer */
  private overviewFailure: string | null = null;
  /** the number of the overview answer last applied */
  private overviewSeq = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly confirms = new Map<string, Confirm>();
  /** units whose latest known submission the peer's checks have not decided */
  private readonly open = new Set<string>();
  /** this page's publishes and withdrawals not settled yet */
  private readonly unsettledAttempts = new Map<string, Identity>();
  private readonly queue: string[] = [];
  private draining = false;
  /** operations ended so far, and each unit's count at its last one */
  private ended = 0;
  private readonly endedAt = new Map<string, number>();
  /** reads started so far, and the number of the read last applied per unit */
  private reads = 0;
  private readonly appliedRead = new Map<string, number>();
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly listeners = new Set<(event: SyncEvent) => void>();

  constructor(
    readonly peer: SyndicationPeerInfo,
    /** reads every peer's status of a note and offers it back */
    readonly read: (note: string) => Promise<void>,
  ) {}

  subscribe(fn: (event: SyncEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** a view shows this peer: every unresolved submission is re-read while it
   *  watches; the returned function ends the watch */
  watch(): () => void {
    this.watchers += 1;
    this.schedule();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      this.watchers -= 1;
      this.schedule();
    };
  }

  status(unit: string): SyndicationUnitStatus | null {
    return this.statuses.get(unit) ?? null;
  }

  job(unit: string): Job | null {
    return this.jobs.get(unit) ?? null;
  }

  attempt(unit: string): Attempt | null {
    return this.attempts.get(unit) ?? null;
  }

  confirm(unit: string): Confirm | null {
    return this.confirms.get(unit) ?? null;
  }

  /** open the question `key` asks about the unit */
  ask(unit: string, key: string): void {
    this.confirms.set(unit, { key, asking: true });
    this.changed(unit);
  }

  /** close it unanswered */
  unask(unit: string): void {
    const open = this.confirms.get(unit);
    if (!open) return;
    this.confirms.set(unit, { key: open.key, asking: false });
    this.changed(unit);
  }

  /** a submission of the unit is undecided as far as this page knows — the
   *  peer's checks run, or this page's attempt has not shown its ending */
  unresolved(unit: string): boolean {
    return this.open.has(unit) || this.unsettledAttempts.has(unit);
  }

  /** this page's publish or withdraw of the unit has not shown how it ended */
  unsettled(unit: string): boolean {
    return this.unsettledAttempts.has(unit);
  }

  /** the overview's rows, in the order of the latest overview read */
  overview(): SyndicationOverviewCopy[] {
    return (this.rowOrder ?? []).flatMap((unit) => this.rows.get(unit) ?? []);
  }

  /** an overview read has arrived */
  overviewRead(): boolean {
    return this.rowOrder !== null;
  }

  /** null when the latest overview read reached the peer; the peer's error
   *  line (possibly empty) when it could not */
  overviewError(): string | null {
    return this.overviewFailure;
  }

  /** number a read as it starts; its answer is offered with the ticket */
  beginRead(): ReadTicket {
    this.reads += 1;
    return { seq: this.reads, ended: this.ended, at: Date.now() };
  }

  /** a status read's answer */
  offerStatus(status: SyndicationUnitStatus, ticket: ReadTicket): void {
    if (!this.fresh(status.unit, ticket)) return;
    this.appliedRead.set(status.unit, ticket.seq);
    this.take(status);
    if (status.state === 'ready') this.settle(status.unit, status, ticket.at);
  }

  /** read the overview into the store */
  async readOverview(): Promise<void> {
    const ticket = this.beginRead();
    const { peers } = await api.get<SyndicationOverviewResponse>('/syndication/overview');
    const entry = peers.find((candidate) => candidate.peer.id === this.peer.id);
    this.offerOverview(entry ?? { peer: { ...this.peer, url: '' }, state: 'unreachable', copies: [] }, ticket);
  }

  /** an overview read's answer: applied only when no newer overview answer
   *  was; an unreachable peer leaves the rows as they were. A row comes,
   *  changes or goes only when the answer is fresh for its unit; a cached
   *  status of the unit follows the row. */
  offerOverview(entry: SyndicationOverviewResponse['peers'][number], ticket: ReadTicket): void {
    if (ticket.seq < this.overviewSeq) return;
    this.overviewSeq = ticket.seq;
    if (entry.state !== 'ready') {
      this.overviewFailure = entry.error ?? '';
      this.emit({ kind: 'overview' });
      return;
    }
    this.overviewFailure = null;
    const before = this.rowOrder ?? [];
    const listed = new Set(entry.copies.map((row) => row.unit));
    const fresh = new Set([...listed, ...before].filter((unit) => this.fresh(unit, ticket)));
    for (const unit of fresh) this.appliedRead.set(unit, ticket.seq);
    this.rowOrder = [
      ...entry.copies.map((row) => row.unit).filter((unit) => fresh.has(unit) || before.includes(unit)),
      ...before.filter((unit) => !listed.has(unit) && !fresh.has(unit)),
    ];
    for (const unit of before) {
      if (!listed.has(unit) && fresh.has(unit)) this.rows.delete(unit);
    }
    for (const row of entry.copies) {
      if (!fresh.has(row.unit)) continue;
      this.track(row.unit, row.submission?.state === 'pending');
      this.reconcile(row);
      if (!same(this.rows.get(row.unit), row)) {
        this.rows.set(row.unit, row);
        this.changed(row.unit);
      }
      this.settle(row.unit, row, ticket.at);
    }
    this.emit({ kind: 'overview' });
  }

  /** publish now (the note popover); no-op while the unit has an operation */
  publish(unit: string, request: SyndicationPublishRequest): void {
    void this.run(unit, 'publish', (job) => this.publishing(unit, job, request), false);
  }

  withdraw(unit: string, note: string, force: boolean): void {
    void this.run(
      unit,
      'withdraw',
      async () =>
        (await api.post<SyndicationActionResponse>(`${this.route}/withdraw`, force ? { note, force } : { note })).status,
      false,
    );
  }

  /** resolves with how it ended */
  async saveOverrides(unit: string, note: string, fields: Record<string, unknown> | null): Promise<Outcome> {
    const attempt = await this.run(
      unit,
      'overrides',
      async () => (await api.post<SyndicationActionResponse>(`${this.route}/overrides`, { note, fields })).status,
      false,
    );
    return attempt?.outcome ?? 'failed';
  }

  /** publish these units one after another (the overview); units with an
   *  operation or an unresolved submission are left out */
  enqueue(units: string[]): void {
    for (const unit of units) {
      if (this.jobs.has(unit) || this.unresolved(unit)) continue;
      this.jobs.set(unit, { action: 'publish', state: 'queued', progress: null, submitted: null });
      this.queue.push(unit);
      this.changed(unit);
    }
    void this.drain();
  }

  /** take a waiting unit out of the queue */
  dequeue(unit: string): void {
    if (this.jobs.get(unit)?.state !== 'queued') return;
    this.jobs.delete(unit);
    this.queue.splice(this.queue.indexOf(unit), 1);
    this.changed(unit);
  }

  private get route(): string {
    return `/syndication/${encodeURIComponent(this.peer.id)}`;
  }

  private publishing(unit: string, job: Job, request: SyndicationPublishRequest): Promise<SyndicationUnitStatus> {
    return publishStream(this.peer.id, request, {
      progress: (progress) => {
        job.progress = progress;
        this.emit({ kind: 'progress', unit });
      },
      submitted: (commit, revision) => {
        job.submitted ??= { commit, revision, at: Date.now() };
        this.changed(unit);
      },
    });
  }

  private emit(event: SyncEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** the unit's state changed: views hear it, polling follows it */
  private changed(unit: string): void {
    this.emit({ kind: 'changed', unit });
    this.schedule();
  }

  /** the read started after the last read applied to the unit, and after
   *  the unit's last operation ended */
  private fresh(unit: string, ticket: ReadTicket): boolean {
    return ticket.seq > (this.appliedRead.get(unit) ?? 0) && (this.endedAt.get(unit) ?? 0) <= ticket.ended;
  }

  private track(unit: string, pending: boolean): void {
    if (pending) this.open.add(unit);
    else this.open.delete(unit);
  }

  /** settle this page's unresolved attempt on the unit from a readable
   *  answer that started at `readAt` */
  private settle(unit: string, seen: Seen, readAt: number): void {
    const identity = this.unsettledAttempts.get(unit);
    if (!identity) return;
    const verdict = judge(identity, seen, readAt, readAt - identity.since > FRESHNESS_MS);
    if (verdict === null || verdict === 'pending') return;
    this.conclude(unit, identity, verdict === 'overtaken' ? null : verdict);
  }

  /** an unresolved attempt ended; null when it was overtaken and has no
   *  ending of its own to tell */
  private conclude(unit: string, identity: Identity, outcome: Outcome | null): void {
    this.unsettledAttempts.delete(unit);
    if (outcome) {
      const ended: Attempt = { action: identity.action, outcome, failure: null, at: Date.now() };
      this.attempts.set(unit, ended);
      this.emit({ kind: 'settled', unit, attempt: ended, queued: false });
    }
    this.changed(unit);
  }

  /** a cached status follows a fresh overview row of its unit; one cached
   *  while the peer was unreachable is read anew instead */
  private reconcile(row: SyndicationOverviewCopy): void {
    const status = this.statuses.get(row.unit);
    if (!status) return;
    if (status.state !== 'ready') {
      void this.read(row.unit).catch(() => {});
      return;
    }
    const next: SyndicationUnitStatus = {
      ...status,
      copy: row.copy,
      behind: row.behind,
      revision: row.revision,
      synced: row.synced,
      copyUrl: row.copyUrl,
      submission: row.submission,
    };
    if (same(status, next)) return;
    this.statuses.set(row.unit, next);
    this.changed(row.unit);
  }

  /** the unresolved units due a re-read (none with a running operation) */
  private due(): string[] {
    const units = new Set([...(this.watchers > 0 ? this.open : []), ...this.unsettledAttempts.keys()]);
    return [...units].filter((unit) => !this.jobs.has(unit));
  }

  private schedule(): void {
    const wanted = this.due().length > 0;
    if (wanted && this.timer === null) this.timer = setInterval(() => void this.poll(), POLL_MS);
    else if (!wanted && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** one poll at a time: the overview once for units it lists, a status
   *  read for every unit this page has a status of */
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const due = this.due();
      const reads: Promise<void>[] = [];
      if (due.some((unit) => this.rows.has(unit))) reads.push(this.readOverview());
      for (const unit of due) if (this.statuses.has(unit) || !this.rows.has(unit)) reads.push(this.read(unit));
      await Promise.allSettled(reads);
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  /** a status of known freshness: the store, the unresolved set and the
   *  overview row follow it; an unreachable answer settles nothing */
  private take(status: SyndicationUnitStatus): void {
    const { unit } = status;
    if (status.state === 'ready') this.track(unit, status.submission?.state === 'pending');
    const row = this.rows.get(unit);
    const merged = row && mergeRow(row, status);
    const changed = !same(this.statuses.get(unit), status) || !same(row, merged);
    this.statuses.set(unit, status);
    if (merged) this.rows.set(unit, merged);
    if (changed) this.changed(unit);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const tally: Record<Outcome, number> = { accepted: 0, pending: 0, rejected: 0, failed: 0, unknown: 0 };
    for (let unit = this.queue.shift(); unit !== undefined; unit = this.queue.shift()) {
      this.jobs.delete(unit);
      const request = { note: unit };
      const attempt = await this.run(unit, 'publish', (job) => this.publishing(unit, job, request), true);
      if (attempt) tally[attempt.outcome] += 1;
    }
    this.draining = false;
    this.emit({ kind: 'drained', tally });
  }

  /** run one operation on the unit; null when the unit already has one */
  private async run(
    unit: string,
    action: Action,
    work: (job: Job) => Promise<SyndicationUnitStatus>,
    queued: boolean,
  ): Promise<Attempt | null> {
    if (this.jobs.has(unit)) return null;
    const job: Job = { action, state: 'running', progress: null, submitted: null };
    const shown = this.statuses.get(unit) ?? this.rows.get(unit);
    const before = { commit: shown?.submission?.commit ?? null, revision: shown?.revision ?? null };
    const started = Date.now();
    this.jobs.set(unit, job);
    this.confirms.delete(unit);
    this.changed(unit);

    let status: SyndicationUnitStatus | null = null;
    let failure: Failure | null = null;
    try {
      status = await work(job);
    } catch (err) {
      failure = failureOf(err);
    }

    this.jobs.delete(unit);
    this.ended += 1;
    this.endedAt.set(unit, this.ended);
    const now = Date.now();
    let outcome: Outcome;
    let identity: Identity | null = null;
    if (action === 'overrides') outcome = status ? 'accepted' : failedOutcome(action, failure!, false);
    else {
      identity = {
        action,
        before,
        started,
        commit: job.submitted?.commit ?? null,
        revision: job.submitted?.revision ?? null,
        since: now,
      };
      const verdict = status?.state === 'ready' ? judge(identity, status, now, false) : null;
      outcome = !status ? failedOutcome(action, failure!, job.submitted !== null) : verdict === null || verdict === 'overtaken' ? 'unknown' : verdict;
    }
    const attempt: Attempt = { action, outcome, failure, at: now };
    this.attempts.set(unit, attempt);
    if (status) this.take(status);
    if (identity && (outcome === 'pending' || outcome === 'unknown')) this.unsettledAttempts.set(unit, identity);
    this.changed(unit);
    this.emit({ kind: 'settled', unit, attempt, queued });
    if (!status) await this.read(unit).catch(() => {});
    return attempt;
  }
}
