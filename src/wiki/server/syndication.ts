/**
 * Syndication — publishing a note (its unit: the note with its sub-pages,
 * demos, attachments and locale mirrors) to another inkbrush wiki, and
 * keeping it there as a copy the peer serves as its own page.
 *
 * The two wikis never talk to each other. This wiki reads the peer's
 * content repository through a private mirror (./syndication-peer.ts),
 * builds the copy — the unit transformed for the peer (lib/syndication-
 * transform.ts), checked with this wiki's own body gates, every note
 * stamped with `origin` — as a commit on the peer's published tip, and
 * pushes it to the staging branch `syndicate/<name>/<unit>` of the peer's
 * repository. The peer's own CI runs the engine's gate script on that
 * branch: it verifies the submission, runs the peer's checks, and either
 * promotes the commit to the published branch or records a verdict at
 * `<name>/<unit>.json` on its syndication-verdicts branch. Everything this wiki shows about a
 * copy — current, behind, changed on the peer, pending, rejected — is
 * derived from the peer's refs, so it is always re-derivable.
 *
 * Feature off (no `syndication.peers`) ⇒ routes 404 and the client
 * mounts nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { setFrontmatterFields } from '../../lib/frontmatter-edit.ts';
import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { validateNoteSource } from '../../lib/render-pipeline.ts';
import { blobId, collectUnit, isNoteFile, stableJson, unitNameProblem, unitOf, unitRoots, type Bundle } from '../../lib/syndication-bundle.ts';
import { buildTree, changedPaths, commitTree, committerIdentity, GitError, push, writeBlobs, type Repo } from '../../lib/syndication-git.ts';
import { decide, stagingBranch, submissionMessage, type Expectation } from '../../lib/syndication-state.ts';
import { transformUnit, type TransformResult } from '../../lib/syndication-transform.ts';
import type { WikiNoteInfo } from '../../lib/wikilink-core.ts';
import type { SyndicationPeer } from '../config.ts';
import type {
  CopyState,
  SyndicationActionResponse,
  SyndicationErrorCode,
  SyndicationNoteResponse,
  SyndicationOverridesRequest,
  SyndicationOverviewCopy,
  SyndicationOverviewResponse,
  SyndicationPeerInfo,
  SyndicationPublishRequest,
  SyndicationStage,
  SyndicationStreamEvent,
  SyndicationUnitStatus,
  SyndicationWithdrawRequest,
} from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import type { Ctx, RouteRegistrar } from './index.ts';
import { HttpError, json, ndjsonStream, readBody } from './index.ts';
import { revisionSpan } from './job-postconditions.ts';
import { createRootedScanner } from './note-scan.ts';
import { siteHooks, noteUrl } from './site.ts';
import { latestMtime } from './snapshot.ts';
import { autocommit, contentRoot, copyOrigin, journalRevision, noteFile, noteMeta, writeNote } from './source.ts';
import { fetchPeer, FETCH_FRESH_MS, fileAtUnitRoot, mirrorDir, peerUnitRoots, peerView, submissionOf, unitState, type PeerView } from './syndication-peer.ts';
import { wikiTempDir } from './store.ts';

/** the classification a plan previews */
const PLAN_FIELDS = ['kind', 'domains', 'tags', 'status'];

/** how long a publish waits for the peer's gate before answering with the pending submission */
const VERDICT_WAIT_MS = 8 * 60_000;
const VERDICT_POLL_MS = 10_000;

/* ---------------- configuration ---------------- */

export function syndicationPeers(): SyndicationPeerInfo[] {
  return wikiConfig().syndication.peers.map((p) => ({ id: p.id, title: p.title }));
}

function peers(): readonly SyndicationPeer[] {
  return wikiConfig().syndication.peers;
}

/** the name copies carry as origin.wiki (set whenever peers exist) */
function originName(): string {
  return wikiConfig().syndication.name!;
}

function peerInfo(peer: SyndicationPeer): SyndicationUnitStatus['peer'] {
  return { id: peer.id, title: peer.title, url: new URL(peer.url.replace('{id}', 'x')).origin };
}

function copyUrl(peer: SyndicationPeer, unit: string): string {
  return peer.url.replace('{id}', unit);
}

/* ---------------- errors ---------------- */

/** why a publish or withdrawal did not go through, with the HTTP status
 *  the plain JSON routes answer */
export class SyndicationError extends Error {
  readonly code: SyndicationErrorCode;
  readonly problems: string[] | undefined;
  constructor(code: SyndicationErrorCode, message: string, problems?: string[]) {
    super(message);
    this.name = 'SyndicationError';
    this.code = code;
    this.problems = problems;
  }
  get status(): number {
    return this.code === 'unreachable' ? 502 : this.code === 'invalid' ? 422 : 409;
  }
  toHttp(): HttpError {
    return new HttpError(this.status, this.message, { code: this.code, ...(this.problems ? { problems: this.problems } : {}) });
  }
}

function unreachable(err: unknown): SyndicationError {
  return new SyndicationError('unreachable', err instanceof GitError ? err.message : err instanceof Error ? err.message : String(err));
}

/* ---------------- the unit here ---------------- */

const originNotes = createRootedScanner();

function localePrefixes(): string[] {
  return wikiConfig().content.locales.map((l) => l.prefix);
}

/** the unit's files, or null when the unit does not exist here */
function unitFiles(unit: string): Bundle | null {
  try {
    return collectUnit(contentRoot(), unit, localePrefixes());
  } catch {
    return null;
  }
}

function sourceChangedAt(unit: string): string | undefined {
  const dirs = unitRoots(unit, localePrefixes()).map((root) => join(contentRoot(), root));
  const latest = Math.max(0, ...dirs.map((dir) => latestMtime(dir)));
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

/* ---------------- the transform, cached ---------------- */

const TRANSFORM_CACHE = 64;
const transforms = new Map<string, { inputs: string; result: TransformResult }>();
const noteListKeys = new WeakMap<WikiNoteInfo[], { urlFor: unknown; key: string }>();

/** a fingerprint of the unit's files: every path with its mode and its exact bytes */
function filesKey(files: Bundle): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    const { bytes, mode } = files.get(path)!;
    hash.update(`${path}\0${mode} ${blobId(bytes)}\n`);
  }
  return hash.digest('hex');
}

/** the notes and the URL the site's rule gives each of them: every id the
 *  transform may consult, fingerprinted once per scan and URL rule */
function noteListKey(notes: WikiNoteInfo[]): string {
  const urlFor = siteHooks().urlFor;
  const known = noteListKeys.get(notes);
  if (known && known.urlFor === urlFor) return known.key;
  const hash = createHash('sha256').update(stableJson(notes));
  for (const note of notes) hash.update(`\0${note.id}\0${noteUrl(note.id)}`);
  const key = hash.digest('hex');
  noteListKeys.set(notes, { urlFor, key });
  return key;
}

/** the unit as the peer will hold it — recomputed only when an input changed */
function transformFor(peer: SyndicationPeer, unit: string, files: Bundle, view: PeerView): TransformResult {
  const notes = originNotes(contentRoot());
  const inputs = [
    peer.id,
    peer.repo,
    peer.branch,
    peer.contentDir,
    peer.locales.join(','),
    stableJson(peer.map),
    originName(),
    wikiConfig().content.locales.map((l) => l.prefix).join(','),
    view.tip ?? '',
    filesKey(files),
    noteListKey(notes),
  ].join('\0');
  const key = `${peer.id}\0${unit}`;
  const cached = transforms.get(key);
  if (cached?.inputs === inputs) return cached.result;
  const result = transformUnit({
    unit,
    files,
    peer: { id: peer.id, map: peer.map },
    locales: wikiConfig().content.locales,
    peerLocales: peer.locales.map((prefix) => ({ prefix })),
    originNotes: notes,
    urlForOrigin: noteUrl,
    peerNotes: view.notes,
    originName: originName(),
  });
  transforms.delete(key);
  transforms.set(key, { inputs, result });
  if (transforms.size > TRANSFORM_CACHE) transforms.delete(transforms.keys().next().value!);
  return result;
}

/* ---------------- status ---------------- */

/** the view after a fetch no older than `maxAgeMs` (0 = fetch now) */
async function freshView(peer: SyndicationPeer, maxAgeMs: number): Promise<PeerView> {
  await fetchPeer(peer, originName(), maxAgeMs);
  return peerView(peer, originName());
}

function copyStateOf(view: PeerView, unit: string, transform: TransformResult | null): { copy: CopyState; behind: boolean } {
  const state = unitState(view, unit, originName());
  switch (state.kind) {
    case 'absent':
      return { copy: 'absent', behind: false };
    case 'native':
      return { copy: 'occupied', behind: false };
    case 'foreign':
      return { copy: 'foreign', behind: false };
    case 'copy': {
      const behind = transform?.ok === true && transform.digest !== state.revision;
      if (state.digest !== state.revision) return { copy: 'changed', behind };
      return { copy: behind ? 'behind' : 'current', behind };
    }
  }
}

/**
 * The submission the peer has not accepted, as far as it still answers
 * anything: a pending one always; a publish rejection only while what
 * publishing now would send is the revision it refused (once the note or
 * its overrides changed, the verdict answers nothing); a withdraw
 * rejection while the copy still exists.
 */
function currentSubmission(view: PeerView, unit: string, transform: TransformResult | null): SyndicationUnitStatus['submission'] {
  const submission = submissionOf(view, unit);
  if (!submission || submission.state === 'pending') return submission;
  if (submission.action === 'withdraw') return view.copies.has(unit) ? submission : undefined;
  return transform?.ok === true && transform.digest === submission.revision ? submission : undefined;
}

/** the unit's status on one peer, from a view of the peer */
function statusFrom(peer: SyndicationPeer, unit: string, view: PeerView): SyndicationUnitStatus {
  const files = unitFiles(unit);
  const transform = files ? transformFor(peer, unit, files, view) : null;
  const { copy, behind } = copyStateOf(view, unit, transform);
  const stored = view.copies.get(unit);
  const status: SyndicationUnitStatus = {
    peer: peerInfo(peer),
    state: 'ready',
    unit,
    copy,
    behind,
    revision: stored?.revision,
    synced: stored?.synced,
    copyUrl: stored ? copyUrl(peer, unit) : undefined,
    sourceChangedAt: files ? sourceChangedAt(unit) : undefined,
    submission: currentSubmission(view, unit, transform),
  };
  if (transform?.ok) {
    const root = transform.notes.find((n) => n.id === unit);
    const rootData = files ? splitFrontmatter(new TextDecoder().decode((files.get(`${unit}/index.mdx`) ?? files.get(`${unit}/index.md`)!).bytes)).data : {};
    const overrides = (rootData['syndication'] as Record<string, unknown> | undefined)?.[peer.id];
    status.plan = {
      notes: [...transform.bundle.keys()].filter(isNoteFile).length,
      files: transform.bundle.size,
      bytes: [...transform.bundle.values()].reduce((sum, file) => sum + file.bytes.byteLength, 0),
      fields: Object.fromEntries(PLAN_FIELDS.filter((f) => root && f in root.fields).map((f) => [f, root!.fields[f]])),
      overrides: overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? (overrides as Record<string, unknown>) : null,
      degraded: transform.degraded,
      warnings: transform.warnings,
    };
  } else if (transform) {
    status.refusals = transform.refusals;
  } else {
    status.refusals = [{ code: 'no-root', note: unit }];
  }
  return status;
}

/** the unit's status on one peer; a peer whose repository cannot be read is 'unreachable' */
export async function unitStatus(peer: SyndicationPeer, unit: string, maxAgeMs = FETCH_FRESH_MS): Promise<SyndicationUnitStatus> {
  try {
    return statusFrom(peer, unit, await freshView(peer, maxAgeMs));
  } catch (err) {
    return {
      peer: peerInfo(peer),
      state: 'unreachable',
      error: unreachable(err).message,
      unit,
      copy: null,
      behind: false,
      sourceChangedAt: sourceChangedAt(unit),
    };
  }
}

/** every unit of this wiki's the peer holds or is deciding on */
async function peerOverview(peer: SyndicationPeer): Promise<SyndicationOverviewResponse['peers'][number]> {
  let view: PeerView;
  try {
    view = await freshView(peer, FETCH_FRESH_MS);
  } catch (err) {
    return { peer: peerInfo(peer), state: 'unreachable', error: unreachable(err).message, copies: [] };
  }
  const units = new Set<string>([...view.copies.keys(), ...view.staged.keys(), ...view.verdicts.keys()]);
  const copies: SyndicationOverviewCopy[] = [];
  for (const unit of [...units].sort()) {
    const status = statusFrom(peer, unit, view);
    if (status.copy === 'absent' && !status.submission) continue;
    copies.push({
      unit,
      title: noteMeta(unit)?.title ?? unit,
      copy: status.copy!,
      behind: status.behind,
      revision: status.revision,
      synced: status.synced,
      copyUrl: status.copyUrl,
      missing: !noteFile(unit),
      submission: status.submission,
    });
  }
  return { peer: peerInfo(peer), state: 'ready', copies };
}

/* ---------------- publishing and withdrawing ---------------- */

/** units being published or withdrawn right now (`<peer>:<unit>`) */
const busy = new Set<string>();

async function exclusively<T>(peer: SyndicationPeer, unit: string, work: () => Promise<T>): Promise<T> {
  const key = `${peer.id}:${unit}`;
  if (busy.has(key)) throw new SyndicationError('busy', 'This note is being published or withdrawn right now — wait for it to finish');
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}

export type Progress = (stage: SyndicationStage, message: string, seconds?: number) => void;

interface Submitter {
  name: string;
  email: string;
}

/** a fresh view, with the unit's expectation decided for `action` */
async function preflight(
  peer: SyndicationPeer,
  unit: string,
  action: 'publish' | 'withdraw',
  opts: { adopt: boolean; force: boolean },
): Promise<{ dir: Repo; view: PeerView; expect: Expectation }> {
  let dir: Repo;
  let view: PeerView;
  try {
    dir = await fetchPeer(peer, originName());
    view = await peerView(peer, originName());
  } catch (err) {
    throw unreachable(err);
  }
  if (view.stagedRefs.has(unit)) {
    throw new SyndicationError('pending', `A submission of '${unit}' is still being checked by ${peer.title}`);
  }
  const fileThere = fileAtUnitRoot(view, unit);
  if (fileThere !== null) {
    throw new SyndicationError('native', `${peer.title}: '${fileThere}' is a file there — the unit cannot be placed at its path`);
  }
  const state = unitState(view, unit, originName());
  const expect: Expectation =
    state.kind === 'copy' ? { revision: state.revision } : state.kind === 'native' && opts.adopt ? 'adopt' : 'none';
  const decision = decide(state, expect, opts.force, action);
  if (!decision.ok) throw new SyndicationError(decision.code, `${peer.title}: ${decision.message}`);
  return { dir, view, expect };
}

/** the commit's committer: git's identity for the mirror, else this wiki's name */
async function committerFor(dir: Repo): Promise<{ name: string; email: string }> {
  return (await committerIdentity(dir)) ?? { name: originName(), email: 'wiki@local' };
}

/** commit `tree` on the peer's tip and push it to the unit's staging
 *  branch; the tree must differ from the tip only under the unit's
 *  directories — what the gate verifies, verified here first */
async function stage(dir: Repo, peer: SyndicationPeer, view: PeerView, tree: string, message: string, user: Submitter, unit: string): Promise<string> {
  const roots = peerUnitRoots(peer, unit);
  const outside = (await changedPaths(dir, view.tip, tree)).filter((path) => !roots.some((root) => path.startsWith(`${root}/`)));
  if (outside.length > 0) {
    throw new SyndicationError('refused', `the submission would change paths outside the unit's directories: ${outside.join(', ')}`);
  }
  const commit = await commitTree(dir, {
    tree,
    parents: view.tip ? [view.tip] : [],
    message,
    author: { name: user.name, email: user.email },
    committer: await committerFor(dir),
  });
  try {
    await push(dir, 'origin', `${commit}:refs/heads/${stagingBranch(originName(), unit)}`, true);
  } catch (err) {
    throw unreachable(err);
  }
  return commit;
}

function indexFile(peer: SyndicationPeer): string {
  return join(mirrorDir(peer), `index-${randomBytes(6).toString('hex')}`);
}

/**
 * Publish the unit to the peer: transform, check with this wiki's own body
 * gates, stamp `origin`, commit on the peer's tip and push to the staging
 * branch. Resolves with the staged commit and the copy's revision; the
 * peer's gate decides from there (`awaitVerdict`). A copy that is current
 * — intact, at the revision publishing would send — is left alone: null,
 * nothing pushed (force sends it again).
 */
export function submitPublish(
  peer: SyndicationPeer,
  unit: string,
  user: Submitter,
  opts: { adopt?: boolean | undefined; force?: boolean | undefined },
  progress: Progress = () => undefined,
): Promise<{ commit: string; revision: string; synced: string } | null> {
  return exclusively(peer, unit, async () => {
    progress('fetching', `Fetching ${peer.title}'s repository…`);
    const { dir, view, expect } = await preflight(peer, unit, 'publish', { adopt: opts.adopt === true, force: opts.force === true });

    progress('preparing', 'Preparing the copy…');
    const files = unitFiles(unit);
    if (!files) throw new SyndicationError('refused', `'${unit}' is not a unit here`);
    const transform = transformFor(peer, unit, files, view);
    if (!transform.ok) {
      throw new SyndicationError('refused', `'${unit}' cannot be published: ${transform.refusals.map((r) => `${r.note}: ${r.code}`).join(', ')}`);
    }
    const state = unitState(view, unit, originName());
    if (state.kind === 'copy' && state.digest === state.revision && transform.digest === state.revision && opts.force !== true) {
      return null;
    }

    progress('checking', "Checking the copy with this wiki's gates…");
    const site = siteHooks();
    const problems: string[] = [];
    const decoder = new TextDecoder();
    const stamped: Bundle = new Map();
    const synced = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const [path, file] of transform.bundle) {
      if (!isNoteFile(path)) {
        stamped.set(path, file);
        continue;
      }
      const text = decoder.decode(file.bytes);
      const problem = await validateNoteSource(text, {
        site: site.page ?? site,
        guard: site.guard ?? {},
        mdx: path.endsWith('.mdx'),
        path: join(contentRoot(), path),
      });
      if (problem) problems.push(`${path}: ${problem}`);
      else {
        const origin = { wiki: originName(), revision: transform.digest, synced };
        stamped.set(path, { bytes: new TextEncoder().encode(setFrontmatterFields(text, { origin }, { last: ['origin'] })), mode: file.mode });
      }
    }
    if (problems.length > 0) throw new SyndicationError('invalid', 'The copy would not build here', problems);

    progress('submitting', `Submitting to ${stagingBranch(originName(), unit)}…`);
    const repoFiles = new Map([...stamped].map(([path, file]) => [`${peer.contentDir}${path}`, file]));
    const blobs = await writeBlobs(dir, new Map([...repoFiles].map(([path, file]) => [path, file.bytes])), wikiTempDir('syndication'));
    const tree = await buildTree(dir, {
      base: view.tip,
      remove: peerUnitRoots(peer, unit),
      add: [...repoFiles].map(([path, file]) => ({ path, sha: blobs.get(path)!, mode: file.mode })),
      indexFile: indexFile(peer),
    });
    const message = submissionMessage({
      origin: originName(),
      unit,
      action: 'publish',
      expect,
      revision: transform.digest,
      force: opts.force === true,
    });
    const commit = await stage(dir, peer, view, tree, message, user, unit);
    return { commit, revision: transform.digest, synced };
  });
}

/** withdraw the copy: the peer's tip without the unit's directories, pushed to the staging branch */
export function submitWithdraw(peer: SyndicationPeer, unit: string, user: Submitter, opts: { force?: boolean | undefined }): Promise<string> {
  return exclusively(peer, unit, async () => {
    const { dir, view, expect } = await preflight(peer, unit, 'withdraw', { adopt: false, force: opts.force === true });
    const tree = await buildTree(dir, { base: view.tip, remove: peerUnitRoots(peer, unit), add: [], indexFile: indexFile(peer) });
    const message = submissionMessage({ origin: originName(), unit, action: 'withdraw', expect, force: opts.force === true });
    return stage(dir, peer, view, tree, message, user, unit);
  });
}

/**
 * Wait for the peer's gate: accepted once the staging branch is gone and
 * the tip carries the submitted revision intact (or, for a withdrawal, no
 * longer carries the unit), refused when a verdict for the staged commit
 * appears. Gives up after the wait window with the status as it stands —
 * the submission is still pending there, and the peer's refs keep the
 * truth.
 */
export async function awaitVerdict(
  peer: SyndicationPeer,
  unit: string,
  staged: { commit: string; action: 'publish' | 'withdraw'; revision?: string | undefined },
  signal: AbortSignal,
  progress: Progress = () => undefined,
  timing: { waitMs?: number | undefined; pollMs?: number | undefined } = {},
): Promise<SyndicationUnitStatus> {
  const waitMs = timing.waitMs ?? VERDICT_WAIT_MS;
  const pollMs = timing.pollMs ?? VERDICT_POLL_MS;
  const started = Date.now();
  for (;;) {
    let view: PeerView;
    try {
      view = await freshView(peer, 0);
    } catch (err) {
      throw unreachable(err);
    }
    const verdict = view.verdicts.get(unit);
    if (verdict?.staged === staged.commit) {
      throw new SyndicationError('rejected', `${peer.title} refused the submission`, verdict.problems);
    }
    const copy = view.copies.get(unit);
    const accepted =
      !view.stagedRefs.has(unit) &&
      (staged.action === 'publish'
        ? copy !== undefined && copy.revision === staged.revision && copy.digest === staged.revision
        : unitState(view, unit, originName()).kind === 'absent');
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (accepted || Date.now() - started >= waitMs || signal.aborted) return statusFrom(peer, unit, view);
    progress('waiting', `Waiting for ${peer.title}'s gate (${elapsed}s)…`, elapsed);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) return statusFrom(peer, unit, view);
  }
}

/**
 * The publish as the browser follows it: progress lines, then `submitted`
 * the moment the staging push succeeded — from there the outcome is the
 * peer's, whatever happens to this stream — then the gate's outcome as
 * `result` or `error`. `write` receives every event in order.
 */
export async function publishStream(
  peer: SyndicationPeer,
  unit: string,
  user: Submitter,
  opts: { adopt?: boolean | undefined; force?: boolean | undefined },
  write: (event: SyndicationStreamEvent) => void,
  signal: AbortSignal,
  timing?: { waitMs?: number | undefined; pollMs?: number | undefined },
): Promise<void> {
  const progress: Progress = (stage, message, seconds) => {
    write({ kind: 'progress', stage, message, ...(seconds === undefined ? {} : { seconds }) });
  };
  try {
    const staged = await submitPublish(peer, unit, user, opts, progress);
    if (staged) write({ kind: 'submitted', commit: staged.commit, revision: staged.revision });
    const status = staged
      ? await awaitVerdict(peer, unit, { commit: staged.commit, action: 'publish', revision: staged.revision }, signal, progress, timing)
      : await unitStatus(peer, unit);
    write({ kind: 'result', ok: true, status });
  } catch (err) {
    const known = err instanceof SyndicationError ? err : null;
    write({ kind: 'error', message: err instanceof Error ? err.message : String(err), code: known?.code, problems: known?.problems });
  }
}

/* ---------------- overrides ---------------- */

/** set (or clear, with null) the unit root's `syndication.<peer>` overrides */
export async function setOverrides(unit: string, peer: SyndicationPeer, fields: Record<string, unknown> | null, user: Submitter): Promise<void> {
  const located = noteFile(unit);
  if (!located) throw new HttpError(404, 'Note not found');
  let before = '';
  let after = '';
  let lines = '*';
  await writeNote(
    located.file,
    (current) => {
      const fm = splitFrontmatter(current);
      if (!fm.present || fm.error) return { next: current, error: 'The note has no readable frontmatter block' };
      const existing = fm.data['syndication'];
      if (existing === false) return { next: current, error: 'The note says syndication: false — remove that first' };
      const table = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
      if (fields === null) delete table[peer.id];
      else table[peer.id] = fields;
      const next = setFrontmatterFields(current, { syndication: Object.keys(table).length > 0 ? table : undefined });
      const span = revisionSpan(current, next);
      if (span) ({ before, after, lines } = span);
      return { next };
    },
    () => {
      if (before !== after) journalRevision({ ts: Date.now(), user: user.email, note: unit, lines, via: 'manual', before, after });
    },
    () => autocommit(located.rel, `wiki: ${unit} syndication overrides for ${peer.id}`, user.name),
  );
}

/* ---------------- routes ---------------- */

/** the peer the route names, or 404 */
function requirePeer(ctx: Ctx): SyndicationPeer {
  const peer = peers().find((p) => p.id === ctx.params['peer']);
  if (!peer) throw new HttpError(404, `No such syndication peer: ${ctx.params['peer']}`);
  return peer;
}

/**
 * The unit a note id names: its top-level segment, which must be a unit
 * name (400 otherwise). With `local`, the note and the unit's directory
 * must exist here (404 otherwise) — publishing needs the files; a
 * withdrawal does not, the peer's state decides.
 */
export function noteUnit(note: unknown, local: boolean): string {
  if (typeof note !== 'string' || !note.trim()) throw new HttpError(400, 'missing note');
  const id = note.trim();
  const unit = unitOf(id, wikiConfig().content.locales);
  const problem = unitNameProblem(unit, localePrefixes());
  if (problem) throw new HttpError(400, problem);
  if (local && (!noteMeta(id) || !existsSync(join(contentRoot(), unit)))) throw new HttpError(404, `'${unit}' is not a unit here`);
  return unit;
}

function requireOn(): void {
  if (peers().length === 0) throw new HttpError(404, 'Syndication is not configured (inkbrush.config.ts → syndication)');
}

export function registerSyndicationRoutes(on: RouteRegistrar): void {
  on(
    'GET',
    '/syndication',
    async ({ res, query }) => {
      requireOn();
      const note = query.get('note') ?? '';
      const meta = noteMeta(note);
      if (!meta) throw new HttpError(404, 'Note not found');
      const unit = unitOf(note, wikiConfig().content.locales);
      const isCopy = copyOrigin(note);
      const statuses = isCopy || !unit ? [] : await Promise.all(peers().map((peer) => unitStatus(peer, unit)));
      json(res, 200, { unit, isCopy, peers: statuses } satisfies SyndicationNoteResponse);
    },
    { auth: true },
  );

  on(
    'GET',
    '/syndication/overview',
    async ({ res }) => {
      requireOn();
      json(res, 200, { peers: await Promise.all(peers().map(peerOverview)) } satisfies SyndicationOverviewResponse);
    },
    { auth: true },
  );

  on(
    'POST',
    '/syndication/:peer/publish',
    async (ctx) => {
      requireOn();
      const peer = requirePeer(ctx);
      const body = await readBody<SyndicationPublishRequest>(ctx.req);
      const unit = noteUnit(body.note, true);
      const stream = ndjsonStream(ctx.res);
      const closed = new AbortController();
      ctx.res.on('close', () => closed.abort());
      await publishStream(peer, unit, ctx.user!, { adopt: body.adopt, force: body.force }, (event) => stream.write(event), closed.signal);
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/syndication/:peer/withdraw',
    async (ctx) => {
      requireOn();
      const peer = requirePeer(ctx);
      const body = await readBody<SyndicationWithdrawRequest>(ctx.req);
      const unit = noteUnit(body.note, false);
      try {
        await submitWithdraw(peer, unit, ctx.user!, { force: body.force });
      } catch (err) {
        throw err instanceof SyndicationError ? err.toHttp() : err;
      }
      json(ctx.res, 200, { ok: true, status: await unitStatus(peer, unit, 0) } satisfies SyndicationActionResponse);
    },
    { auth: true },
  );

  on(
    'POST',
    '/syndication/:peer/overrides',
    async (ctx) => {
      requireOn();
      const peer = requirePeer(ctx);
      const body = await readBody<SyndicationOverridesRequest>(ctx.req);
      const unit = noteUnit(body.note, true);
      const fields = body.fields;
      if (fields !== null && (!fields || typeof fields !== 'object' || Array.isArray(fields))) {
        throw new HttpError(400, 'fields must be an object of frontmatter fields, or null to clear the overrides');
      }
      await setOverrides(unit, peer, fields, ctx.user!);
      json(ctx.res, 200, { ok: true, status: await unitStatus(peer, unit) } satisfies SyndicationActionResponse);
    },
    { auth: true },
  );
}

