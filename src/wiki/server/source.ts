/**
 * Note source access: id → file resolution inside the content root, line-range
 * block read/patch with optimistic locking, whole-file validation before any
 * write, and the append-only revisions journal (.wiki/data/revisions.ndjson).
 *
 * Write contract: every write of a note runs under the file's lock, re-reads
 * the file, re-checks the block hash against the current bytes, validates the
 * whole resulting file with the dialect, the content guard and the site's
 * own plugins (MDX files are compiled) and replaces the file atomically. A
 * failed validation writes nothing. The save's journal entry and its
 * autocommit run inside the same held lock, so what git stages is exactly
 * what that save wrote — a later save cannot slip its bytes under an
 * earlier save's commit.
 *
 * Edit history is two layers: the journal is the fine-grained per-block
 * audit log (each record has a unique id); git in the content repo is the
 * durable versioning — `autocommit` commits each save with the signed-in
 * user as author, `autopush` pushes asynchronously after each commit (its
 * saves replayed onto origin when another writer pushed first), `follow`
 * takes origin's branch into the checkout every minute so the running server
 * serves it, and `skipCi` marks each commit so no pipeline reacts to a save.
 * Only the checkout's own commits, the saves origin never held, are replayed
 * or pushed: a branch rewound or rewritten on purpose is followed as it is.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { copyOriginOf, unitOf } from '../../lib/syndication-bundle.ts';
import { localePrefixOf } from '../../lib/wikilink-core.ts';
import type { LocaleDef } from '../shared/locales.ts';
import { failure, type WikiFailure } from '../shared/errors.ts';
import type { BlockSource, CopyOrigin, NoteLocale, NoteMeta, RevisionRecord } from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { onDuty } from './duty.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, type HttpError, json, readBody, refusal, refuse } from './index.ts';
import { renderMarkdown } from './markdown.ts';
import { createRootedScanner } from './note-scan.ts';
import { frontmatterField, NOTE_ID } from './note-id.ts';
import { containedPath, realpathDeep } from './paths.ts';
import { appendNdjson, projectRoot, readNdjson, wikiDataDir, withLock, writeFileAtomic } from './store.ts';
import { validateSource } from './validate.ts';

export { validateSource };

const execFileP = promisify(execFile);

/* ---------------- id ↔ file ---------------- */

/** note content directory (relative to the site root) — inkbrush.config.ts → content.dir */
function notesBase(): string {
  return wikiConfig().content.dir;
}

/** cached real content root, keyed on the project root + configured dir */
let realContentRoot: { key: string; path: string } | null = null;

/**
 * Absolute content root — the real path, with real containment enforced:
 * config validation refuses absolute and `..` spellings of content.dir, and
 * this resolves symlinks too, so a content.dir that is a symlink pointing
 * outside the project is refused instead of silently escaping it.
 */
export function contentRoot(): string {
  const key = `${projectRoot()}\0${notesBase()}`;
  if (realContentRoot?.key === key) return realContentRoot.path;
  const real = containedPath(projectRoot(), notesBase());
  if (real === null) {
    throw new Error(
      `content.dir '${notesBase()}' resolves outside the project root — a symlinked content directory must stay inside the site`,
    );
  }
  realContentRoot = { key, path: real };
  return real;
}

/** resolve a note id ("guides/getting-started", "en/getting-started", "inbox/…")
 *  to its source file inside the content root; null when absent or outside.
 *  A note with both index.md and index.mdx is a collision (the scanner
 *  refuses it too) and answers 404 naming it. */
export function noteFile(id: string): { file: string; rel: string } | null {
  if (!NOTE_ID.test(id)) return null;
  const located: Array<{ file: string; rel: string }> = [];
  for (const ext of ['mdx', 'md']) {
    const rel = `${notesBase()}/${id}/index.${ext}`;
    const file = containedPath(contentRoot(), resolve(projectRoot(), rel));
    if (file && existsSync(file)) located.push({ file, rel });
  }
  if (located.length > 1) {
    throw refuse(404, 'note-ambiguous', { id });
  }
  return located[0] ?? null;
}

/** the directory a new note would live in, inside the content root; null when outside */
export function noteDir(id: string): string | null {
  if (!NOTE_ID.test(id)) return null;
  return containedPath(contentRoot(), resolve(projectRoot(), notesBase(), id));
}

/** the deployment's locale table — inkbrush.config.ts → content.locales */
function noteLocales(): readonly LocaleDef[] {
  return wikiConfig().content.locales;
}

/** the locale whose notes live unprefixed (exactly one, enforced at resolve time) */
function defaultLocale(): LocaleDef {
  return noteLocales().find((l) => l.prefix === '')!;
}

/** the locale an id lives in — lib/wikilink-core.ts's rule over the
 *  deployment's table, so the resolver, the editor's [[ completion and the
 *  note metadata never disagree */
export function localeOfId(id: string): NoteLocale {
  const prefix = localePrefixOf(id, noteLocales());
  return noteLocales().find((l) => l.prefix === prefix)?.code ?? defaultLocale().code;
}

/** strip the language prefix: "en/getting-started" → "getting-started" */
export function baseIdOf(id: string): string {
  const prefix = localePrefixOf(id, noteLocales());
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/* ---------------- copies (syndication) ---------------- */

/** the unit a content-root-relative path belongs to, or null outside a unit */
function unitOfRel(rel: string): string | null {
  const unit = unitOf(rel.replaceAll('\\', '/'), noteLocales());
  return unit && unit !== '_meta' && unit !== 'docs' ? unit : null;
}

/**
 * The origin stamp of the unit containing `id`, or null: a unit whose
 * default-locale root note carries `origin` is a copy synced from another
 * wiki, and every file under its directories (in every locale) is
 * read-only here.
 */
export function copyOrigin(id: string): CopyOrigin | null {
  const unit = NOTE_ID.test(id) ? unitOfRel(id) : null;
  const root = unit ? noteFile(unit) : null;
  if (!root) return null;
  const fm = splitFrontmatter(readFileSync(root.file, 'utf8'));
  return fm.error ? null : copyOriginOf(fm.data);
}

/** the origin stamp of the copy an absolute path lies in, or null */
export function copyOriginOfFile(file: string): CopyOrigin | null {
  const rel = relative(contentRoot(), file);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const unit = unitOfRel(rel);
  return unit ? copyOrigin(unit) : null;
}

/** the 423 every local edit of a copy answers with */
export function copyRefusal(origin: CopyOrigin): HttpError {
  return refuse(423, 'copy', { wiki: origin.wiki });
}

/** throws the 423 when `file` (absolute) lies inside a copy */
export function refuseCopyWrite(file: string): void {
  const origin = copyOriginOfFile(file);
  if (origin) throw copyRefusal(origin);
}

export function noteMeta(id: string): NoteMeta | null {
  const located = noteFile(id);
  if (!located) return null;
  const source = readFileSync(located.file, 'utf8');
  const lang = localeOfId(id);
  const base = baseIdOf(id);
  const locales = noteLocales().map((l) => {
    const lid = `${l.prefix}${base}`;
    return {
      code: l.code,
      prefix: l.prefix,
      id: lid,
      label: l.label,
      exists: Boolean(noteFile(lid)),
      current: l.code === lang,
    };
  });
  return {
    id,
    file: located.rel,
    title: frontmatterField(source, 'title') ?? id,
    lang,
    locales,
    origin: copyOrigin(id) ?? undefined,
  };
}

/* ---------------- block read / patch ---------------- */

export function sliceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readBlock(file: string, start: number, end: number): BlockSource | null {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (start < 1 || end < start || end > lines.length) return null;
  const source = lines.slice(start - 1, end).join('\n');
  return { source, hash: sliceHash(source), start, end };
}

/* ---------------- revisions ---------------- */

const revisionsFile = (): string => join(wikiDataDir(), 'revisions.ndjson');

export function journalRevision(record: Omit<RevisionRecord, 'id'>): RevisionRecord {
  const full: RevisionRecord = { id: randomUUID(), ...record };
  appendNdjson(revisionsFile(), full);
  return full;
}

let announceWrite: ((file: string) => void) | undefined;

/** what the dev server is told of each note written (../content-updates.ts), handed over by the integration */
export function setNoteWritten(listener: ((file: string) => void) | undefined): void {
  announceWrite = listener;
}

/**
 * Replace the file's content under its lock: `produce` computes the next
 * content from the file as it is at write time (and refuses with an error
 * when a block no longer matches, → 409), the result is validated (→ 422
 * when it would not build), then written atomically. `afterWrite` runs
 * inside the same lock after the write (journaling belongs there, so the
 * journal order matches the write order), and `commit` runs last, still
 * inside the lock, so the save's autocommit stages exactly what the save
 * wrote — attribution correctness wins over save throughput. Returns the
 * commit outcome (null when no `commit` is given). A file inside a copy
 * synced from another wiki is never written: 423. The dev server is told
 * of each write as it happens (`setNoteWritten`).
 */
export async function writeNote(
  file: string,
  produce: (current: string) => { next: string; error?: WikiFailure | undefined },
  afterWrite?: (next: string) => void,
  commit?: () => Promise<AutocommitResult>,
): Promise<AutocommitResult | null> {
  return await withLock(file, async () => {
    const current = readFileSync(file, 'utf8');
    const { next, error } = produce(current);
    if (error) throw refusal(409, error);
    const problem = await validateSource(file, next);
    if (problem) throw refuse(422, 'save-would-not-build', { detail: problem });
    // decided last, under the lock, after everything that awaits: a unit
    // that became a copy meanwhile is not written
    refuseCopyWrite(file);
    writeFileAtomic(file, next);
    announceWrite?.(file);
    afterWrite?.(next);
    return commit ? await commit() : null;
  });
}

export type AutocommitResult = 'off' | 'clean' | 'committed' | 'failed';

/** `Name <email>` for git: a name carries no angle brackets or line breaks (git would read
 *  them as the address), and an empty one falls back to the address's local part */
function authorIdent({ name, email }: { name: string; email: string }): string {
  const clean = (v: string) => v.replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  const address = clean(email);
  return `${clean(name) || address.split('@')[0] || address} <${address}>`;
}

// git operations on the working tree run one at a time behind this queue, so
// concurrent saves cannot interleave their add/status/commit sequences, and
// origin's commits are taken in between them, never in the middle of one
let gitChain: Promise<unknown> = Promise.resolve();

function inGitQueue<T>(operation: () => Promise<T>): Promise<T> {
  const chained = gitChain.then(operation, operation);
  gitChain = chained.catch(() => undefined);
  return chained;
}

type Git = (...args: string[]) => Promise<{ stdout: string; stderr: string }>;

const gitIn =
  (repoRoot: string, env?: NodeJS.ProcessEnv): Git =>
  (...args) =>
    execFileP('git', args, { cwd: repoRoot, maxBuffer: 64 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) });

/** where the checkout's branch is pushed (`remote`, `remoteRef`) and the branch that tracks it here */
interface UpstreamBranch {
  remote: string;
  remoteRef: string;
  trackingRef: string;
}

async function upstreamBranch(git: Git): Promise<UpstreamBranch> {
  const branch = (await git('symbolic-ref', '--quiet', 'HEAD')).stdout.trim();
  const format = '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)';
  const [remote, remoteRef, trackingRef] = (await git('for-each-ref', format, branch)).stdout.trim().split('\0');
  if (!remote || !remoteRef || !trackingRef) throw new Error(`${branch} has no upstream branch to follow`);
  return { remote, remoteRef, trackingRef };
}

const NULL_OID = /^0+$/;

/**
 * Every tip the upstream branch has held as this checkout saw it: both sides
 * of each line of the tracking branch's reflog, and the tip now. A line
 * records the tip before and after one fetch or push, so a fetch that rewinds
 * or rewrites the upstream writes the tip it left on a fresh line, and that
 * tip stays named however old the line that brought it, and whatever `git gc`
 * expires meanwhile.
 */
async function tipsTheUpstreamHeld(git: Git, repoRoot: string, upstream: UpstreamBranch, tip: string): Promise<string[]> {
  const log = resolve(repoRoot, (await git('rev-parse', '--git-path', `logs/${upstream.trackingRef}`)).stdout.trim());
  const held = new Set([tip]);
  for (const line of existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []) {
    for (const oid of line.split(' ', 2)) if (/^[0-9a-f]{40,64}$/.test(oid) && !NULL_OID.test(oid)) held.add(oid);
  }
  return [...held];
}

/**
 * This checkout's own commits, oldest first: the commits in `head`'s history
 * the upstream never held (none reachable from a tip it held), merges left
 * out. They are the saves this checkout made and has not pushed. Commits the
 * upstream has since removed, by rewinding its branch or rewriting it, were
 * held by it, so they are never this checkout's and are never replayed or
 * pushed back. A tip whose objects `git gc` has pruned holds nothing HEAD has.
 */
async function ownCommits(git: Git, head: string, held: readonly string[]): Promise<string[]> {
  const out = await git('rev-list', '--reverse', '--no-merges', '--ignore-missing', head, '--not', ...held);
  return out.stdout.split('\n').filter(Boolean);
}

/**
 * `commits` (oldest first, none a merge) replayed onto `onto` without
 * touching the working tree or the index, as `git rebase` would replay them:
 * each commit's change from its parent is merged into the replayed tip by
 * `git merge-tree` and committed under the commit's own author and author
 * date with its message. A commit that already sits on the replayed tip is
 * kept as it is; one whose change the replayed tip already holds is dropped.
 * Throws on a conflict, naming the commit and the files. Returns the new tip.
 */
async function replay(repoRoot: string, onto: string, commits: readonly string[]): Promise<string> {
  const git = gitIn(repoRoot);
  let tip = onto;
  for (const commit of commits) {
    const parent = (await git('rev-parse', `${commit}^`)).stdout.trim();
    if (parent === tip) {
      tip = commit;
      continue;
    }
    // merge-tree takes its merge base from history, so the replayed tip's tree enters as a child of the
    // commit's parent: the three-way merge then has that parent as its base, the base a cherry-pick uses
    const tipTree = (await git('rev-parse', `${tip}^{tree}`)).stdout.trim();
    const theirs = (await git('commit-tree', tipTree, '-p', parent, '-m', 'replay base')).stdout.trim();
    const merged = await git('merge-tree', '--write-tree', '--name-only', '--no-messages', theirs, commit).catch(
      (err: { stdout?: string }) => {
        const files = (err.stdout ?? '').split('\n').slice(1).filter(Boolean).join(', ');
        throw new Error(`replaying ${commit} onto ${tip} conflicts in ${files || 'its files'}; the checkout needs a person`);
      },
    );
    const tree = merged.stdout.split('\n')[0]!;
    if (tree === tipTree) continue;
    const [name, email, date, message] = (
      await git('show', '-s', '--date=raw', '--format=%an%x00%ae%x00%ad%x00%B', commit)
    ).stdout.split('\0');
    const author = gitIn(repoRoot, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
    tip = (await author('commit-tree', tree, '-p', tip, '-m', message!.replace(/\n+$/, ''))).stdout.trim();
  }
  return tip;
}

/**
 * Take the upstream branch, as of the last fetch, into the checkout: the
 * checkout becomes the upstream's tip with this checkout's own commits
 * (ownCommits) replayed on top. The one rule covers every way the upstream
 * moves. Moved forward, the checkout fast-forwards, or its saves are replayed
 * onto the new commits; rewound to an older commit or rewritten on purpose,
 * the checkout follows it and only its unpushed saves are replayed onto the
 * new history, so nothing the upstream removed comes back. Other writers push
 * to the same repository (people, pipelines, other sites kept in it).
 *
 * The new commits are written by `git merge-tree` and `git commit-tree`,
 * which touch no file, and the checkout moves to them by `git reset --keep`,
 * which rewrites only the files that differ and stops rather than overwrite
 * one a save has written and not committed yet. It holds the write lock of
 * every such file, the lock a save holds from reading the file to writing it
 * back, so a save reads such a file wholly before the update or wholly after
 * it and never writes back bytes the update replaced. A replay that conflicts
 * (the same lines edited here and on the upstream) is not made and throws:
 * the commits stay local until a person rebases them by hand. The running dev
 * server watches the working tree, so the files that changed are served from
 * the next request on.
 *
 * It runs inside a synchronization (inSyncQueue), so nothing but saves moves
 * HEAD meanwhile. A save committed while the locks were taken only adds a
 * commit on top; inside the git queue the own commits are read again and that
 * save is replayed too, and the files the reset then rewrites are still among
 * those locked: a file outside them is the same in the old HEAD and the
 * update, so the save's change to it replays onto the same bytes. Returns the
 * upstream's tip and the commit the checkout now stands on.
 */
async function takeUpstream(git: Git, repoRoot: string, upstream: UpstreamBranch): Promise<{ tip: string; next: string }> {
  const tip = (await git('rev-parse', '--verify', `${upstream.trackingRef}^{commit}`)).stdout.trim();
  const held = await tipsTheUpstreamHeld(git, repoRoot, upstream, tip);
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const next = await replay(repoRoot, tip, await ownCommits(git, head, held));
  if (next === head) return { tip, next };
  // both sides of a rename: exactly the files the reset rewrites or removes; their locks are taken in
  // sorted order, before the git queue, the order a save takes its file's lock and then the queue for
  // its commit
  const changed = (await git('diff', '--name-only', '--no-renames', '-z', head, next)).stdout.split('\0').filter(Boolean);
  const keys = [...new Set(changed.map((rel) => realpathDeep(resolve(repoRoot, rel))))].sort();
  const update = () =>
    inGitQueue(async () => {
      const now = (await git('rev-parse', 'HEAD')).stdout.trim();
      const target = now === head ? next : await replay(repoRoot, tip, await ownCommits(git, now, held));
      if (target !== now) await git('reset', '--quiet', '--keep', target);
      return { tip, next: target };
    });
  return await keys.reduceRight<() => Promise<{ tip: string; next: string }>>(
    (then, key) => () => withLock(key, then),
    update,
  )();
}

// fetching, taking the upstream in and pushing run one synchronization at a time behind this queue, so a
// follower run and a save's push never interleave and each takes in one upstream tip at a time
let syncChain: Promise<unknown> = Promise.resolve();

function inSyncQueue<T>(operation: () => Promise<T>): Promise<T> {
  const chained = syncChain.then(operation, operation);
  syncChain = chained.catch(() => undefined);
  return chained;
}

/**
 * One synchronization with the upstream: fetch it (`fetch`), take it in
 * (takeUpstream) and, with `push`, push the checkout's own commits on top of
 * it. The push sends the commit taking in made, under a lease on the tip it
 * was built on (`--force-with-lease=<branch>:<tip>`): it goes through only
 * while the upstream still stands at that tip, and the commit descends from
 * that tip, so every push that goes through is a fast-forward, and one made
 * after the upstream was rewound or rewritten unseen is turned back instead
 * of putting the removed commits back.
 */
function synchronize(repoRoot: string, { fetch, push }: { fetch: boolean; push: boolean }): Promise<void> {
  return inSyncQueue(async () => {
    const git = gitIn(repoRoot);
    const upstream = await upstreamBranch(git);
    if (fetch) await git('fetch', '--quiet', '--no-recurse-submodules', upstream.remote);
    const { tip, next } = await takeUpstream(git, repoRoot, upstream);
    if (push && next !== tip) {
      await git('push', '--quiet', `--force-with-lease=${upstream.remoteRef}:${tip}`, upstream.remote, `${next}:${upstream.remoteRef}`);
    }
  });
}

/**
 * Push a save to the upstream: a synchronization without a fetch, which takes
 * nothing new in and pushes the save on the tip it was made on. A push turned
 * back (the upstream moved since the last fetch) is followed by one with a
 * fetch, which replays the saves onto the upstream and pushes them. A replay
 * that conflicts leaves every later push turned back the same way, and the
 * log says so until a person rebases by hand. The network steps run outside
 * the git queue, so no save waits on them.
 */
async function pushToUpstream(repoRoot: string): Promise<void> {
  try {
    await synchronize(repoRoot, { fetch: false, push: true });
    return;
  } catch {
    // turned back: synchronize with a fetch below; any other failure fails again there and is logged
  }
  try {
    await synchronize(repoRoot, { fetch: true, push: true });
  } catch (err) {
    console.error('[wiki autopush]', err);
  }
}

const FOLLOW_INTERVAL_MS = 60_000;
const FOLLOWER_KEY = '__wikiUpstreamFollower';

/**
 * `follow`: every minute, on duty, synchronize with the content repo's
 * upstream branch: fetch it, take it into the checkout (takeUpstream) and,
 * with `autopush`, push the checkout's own commits it leaves on top, the
 * saves replayed onto the upstream and any a save's push left behind. Notes
 * pushed from elsewhere are then live without restarting the server, and a
 * rewound or rewritten upstream is followed without its removed commits
 * coming back. Runs never overlap, a failure is logged once until the next
 * run that ends differently, and starting it again replaces the running one
 * (server module reloads), so one process never runs two followers on two
 * copies of the locks.
 */
export function startUpstreamFollowing(): void {
  const globals = globalThis as Record<string, unknown>;
  (globals[FOLLOWER_KEY] as (() => void) | undefined)?.();
  globals[FOLLOWER_KEY] = undefined;
  const cfg = wikiConfig();
  if (!cfg.follow) return;
  let running = false;
  let lastError = '';
  const tick = async (): Promise<void> => {
    if (running || !onDuty()) return;
    running = true;
    try {
      const repoRoot = (await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: contentRoot() })).stdout.trim();
      await synchronize(repoRoot, { fetch: true, push: cfg.autopush });
      lastError = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) console.error('[wiki follow]', message);
      lastError = message;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), FOLLOW_INTERVAL_MS);
  timer.unref();
  globals[FOLLOWER_KEY] = () => clearInterval(timer);
  void tick();
}

/**
 * Per-save git commit (+ optional async push) of the given project-relative
 * files or directories, executed from the content repo's own top level (so
 * paths outside content.dir but inside the repo commit too), authored by the
 * signed-in person who made the change — their name and email, so the
 * repo's history (and every byline derived from it) names the real person.
 * Returns the outcome; 'failed' also covers a path that lies outside the
 * repo and therefore cannot be committed.
 */
export function autocommit(
  relPaths: string | string[],
  message: string,
  author: { name: string; email: string },
): Promise<AutocommitResult> {
  const cfg = wikiConfig();
  if (!cfg.autocommit) return Promise.resolve('off');
  const run = async (): Promise<AutocommitResult> => {
    let repoRoot: string;
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: contentRoot() });
      repoRoot = stdout.trim();
    } catch (err) {
      console.error('[wiki autocommit] cannot locate the content repo:', err);
      return 'failed';
    }
    const rels: string[] = [];
    let outside = false;
    for (const p of Array.isArray(relPaths) ? relPaths : [relPaths]) {
      const rel = relative(repoRoot, resolve(projectRoot(), p));
      if (rel.startsWith('..') || isAbsolute(rel)) {
        console.error(`[wiki autocommit] path is outside the content repo, cannot commit: ${p}`);
        outside = true;
        continue;
      }
      rels.push(rel);
    }
    if (rels.length === 0) return outside ? 'failed' : 'clean';
    try {
      await execFileP('git', ['add', '-A', '--', ...rels], { cwd: repoRoot });
      const { stdout } = await execFileP('git', ['status', '--porcelain', '--', ...rels], { cwd: repoRoot });
      if (!stdout.trim()) return outside ? 'failed' : 'clean';
      // `[skip ci]` as its own trailing line: GitHub Actions and dokploy look for
      // the marker anywhere in the message, and the subject line stays readable.
      const text = cfg.skipCi ? `${message}\n\n[skip ci]` : message;
      await execFileP('git', ['commit', '-m', text, '--author', authorIdent(author), '--', ...rels], {
        cwd: repoRoot,
      });
    } catch (err) {
      console.error('[wiki autocommit]', err);
      return 'failed';
    }
    // the save never waits on the network
    if (cfg.autopush) void pushToUpstream(repoRoot);
    return outside ? 'failed' : 'committed';
  };
  return inGitQueue(run);
}

/* ---------------- routes ---------------- */

export function registerSourceRoutes(on: RouteRegistrar): void {
  on('GET', '/meta/*id', ({ res, params }) => {
    const meta = noteMeta(params['id']!);
    if (!meta) return fail(res, 404, 'note-not-found');
    json(res, 200, meta);
  });

  // reading source is editor-only (anonymous readers only see rendered pages)
  on(
    'GET',
    '/block/*id',
    ({ res, params, query }) => {
      const located = noteFile(params['id']!);
      if (!located) return fail(res, 404, 'note-not-found');
      const start = Number(query.get('start'));
      const end = Number(query.get('end'));
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return fail(res, 400, 'bad-request', { detail: 'start/end must be integer line numbers' });
      }
      const block = readBlock(located.file, start, end);
      if (!block) return fail(res, 416, 'line-range');
      json(res, 200, block);
    },
    { auth: true },
  );

  on(
    'PUT',
    '/block/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      const located = noteFile(id);
      if (!located) return fail(res, 404, 'note-not-found');
      const body = await readBody<{ start: number; end: number; hash: string; source: string }>(req);
      const { start, end, hash, source } = body;
      if (!Number.isInteger(start) || !Number.isInteger(end) || typeof source !== 'string' || typeof hash !== 'string') {
        return fail(res, 400, 'bad-request', { detail: 'missing start/end/hash/source' });
      }
      let before = '';
      const git = await writeNote(
        located.file,
        (current) => {
          const lines = current.split('\n');
          if (start < 1 || end < start || end > lines.length) {
            return { next: current, error: failure('line-range') };
          }
          before = lines.slice(start - 1, end).join('\n');
          if (sliceHash(before) !== hash) {
            return { next: current, error: failure('block-changed') };
          }
          return { next: [...lines.slice(0, start - 1), ...source.split('\n'), ...lines.slice(end)].join('\n') };
        },
        // journaled inside the file's lock, so journal order = write order
        () =>
          journalRevision({
            ts: Date.now(),
            user: user!.email,
            note: id,
            lines: `${start}-${end}`,
            via: 'manual',
            before,
            after: source,
          }),
        // committed inside the same lock: what git stages is this save's bytes
        () => autocommit(located.rel, `wiki: ${id} L${start}-${end} manual edit`, user!),
      );
      json(res, 200, git === 'failed' ? { ok: true, git: 'failed' } : { ok: true });
    },
    { auth: true },
  );

  // the render oracle serves the editing surface only (preview / chat panel,
  // both behind login). sanitize defaults to true — the editor previewing
  // trusted repo content says so explicitly
  on(
    'POST',
    '/render',
    async ({ req, res }) => {
      const { markdown, sanitize, note } = await readBody<{
        markdown?: string;
        sanitize?: boolean;
        note?: string;
      }>(req);
      if (typeof markdown !== 'string') return fail(res, 400, 'bad-request', { detail: 'missing markdown' });
      json(res, 200, {
        html: await renderMarkdown(markdown, {
          sanitize: sanitize ?? true,
          ...(typeof note === 'string' ? { note } : {}),
        }),
      });
    },
    { auth: true },
  );

  // note list for [[ autocomplete / wikilink resolution (inbox included —
  // everything is linkable); the scan is cached for a short window and keyed
  // by the content root current at request time — routes register at module
  // load, before the project root is pinned, so the scanner must not bind
  // a root here
  const notes = createRootedScanner();
  on('GET', '/notes', ({ res }) => {
    json(res, 200, { notes: notes(contentRoot()) });
  });

  // revision history (with full before/after source) is editor-only
  on(
    'GET',
    '/revisions/*id',
    ({ res, params }) => {
      const all = readNdjson<RevisionRecord>(revisionsFile());
      json(res, 200, { revisions: all.filter((r) => r.note === params['id']).slice(-100) });
    },
    { auth: true },
  );

  // one-click revert of a journaled block revision: exact-match replace of
  // the revision's `after` span with its `before`. The match must be
  // unambiguous: no match is a 409; several matches fall back to the one
  // overlapping the recorded line span, and stay a 409 when none or more
  // than one does.
  on(
    'POST',
    '/revert/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      const located = noteFile(id);
      if (!located) return fail(res, 404, 'note-not-found');
      const { id: revisionId } = await readBody<{ id?: string }>(req);
      if (typeof revisionId !== 'string' || !revisionId) return fail(res, 400, 'bad-request', { detail: 'missing revision id' });
      const rec = readNdjson<RevisionRecord>(revisionsFile()).find((r) => r.note === id && r.id === revisionId);
      if (!rec) return fail(res, 404, 'revision-not-found');
      if (rec.lines === '*') return fail(res, 400, 'revert-whole-file');
      if (rec.before === rec.after) return fail(res, 400, 'revert-no-change');

      let at = -1;
      const beforeLines = rec.before.split('\n');
      const git = await writeNote(
        located.file,
        (current) => {
          const fileLines = current.split('\n');
          const target = rec.after.split('\n');
          const matches: number[] = [];
          for (let i = 0; i + target.length <= fileLines.length; i++) {
            if (target.every((line, j) => fileLines[i + j] === line)) matches.push(i);
          }
          if (matches.length === 0) {
            return { next: current, error: failure('revert-overwritten') };
          }
          let chosen = matches;
          if (matches.length > 1) {
            // several matches: only the one overlapping the recorded line
            // span is unambiguous (match at index i covers lines i+1..i+len)
            const span = /^(\d+)-(\d+)$/.exec(rec.lines);
            chosen = span
              ? matches.filter((i) => i + 1 <= Number(span[2]) && i + target.length >= Number(span[1]))
              : [];
          }
          if (chosen.length !== 1) {
            return { next: current, error: failure('revert-ambiguous') };
          }
          at = chosen[0]!;
          return {
            next: [...fileLines.slice(0, at), ...beforeLines, ...fileLines.slice(at + target.length)].join('\n'),
          };
        },
        // journaled inside the file's lock, so journal order = write order
        () =>
          journalRevision({
            ts: Date.now(),
            user: user!.email,
            note: id,
            lines: `${at + 1}-${at + beforeLines.length}`,
            via: 'revert',
            before: rec.after,
            after: rec.before,
          }),
        // committed inside the same lock: what git stages is this revert's bytes
        () => autocommit(located.rel, `wiki: ${id} revert ${rec.via} revision ${rec.id}`, user!),
      );
      json(res, 200, git === 'failed' ? { ok: true, git: 'failed' } : { ok: true });
    },
    { auth: true },
  );
}
