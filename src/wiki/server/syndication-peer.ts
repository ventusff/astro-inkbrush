/**
 * The origin's view of a peer, read from a private bare mirror of the
 * peer's content repository (`.wiki/data/syndication/<peer>.git`). The
 * mirror is a partial clone — blobs above 1 MiB stay on the remote, and
 * nothing here needs them: notes are small text, and every other file
 * enters the digest by its blob id and mode — fetched with three refspecs:
 *
 *   refs/heads/<branch>              → refs/peer/base        the published tip
 *   refs/heads/syndicate/<name>/*    → refs/peer/staged/*    submissions awaiting the gate
 *   refs/heads/syndication-verdicts  → refs/peer/verdicts    the gate's refusals, one file per unit
 *
 * The peer's content is read (frontmatter parsed as YAML), never
 * imported: no code of the peer executes here. Git runs with the
 * server's own environment — ssh configuration, credential helper — as
 * autopush does; a fetch younger than 15 s serves status reads, and a
 * publish or withdrawal always fetches first.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { copyOriginOf, digestOfParts, entryPart, inUnitRoots, isNoteFile, noteIdOfPath, unitOf, unitRoots } from '../../lib/syndication-bundle.ts';
import { commitInfo, git, GitError, isRegularFile, listRefs, listTree, readBlobs, type Repo, type TreeEntry } from '../../lib/syndication-git.ts';
import { parseSubmission, unitStateFrom, VERDICTS_BRANCH, type Submission, type UnitState, type Verdict } from '../../lib/syndication-state.ts';
import type { PeerNoteInfo } from '../../lib/syndication-transform.ts';
import { noteInfoFromSource } from '../../lib/wikilinks.ts';
import type { SyndicationPeer } from '../config.ts';
import type { CopyOrigin, SyndicationSubmission } from '../shared/types.ts';
import { containedPath } from './paths.ts';
import { wikiDataDir, withLock } from './store.ts';

/** blobs above this size stay on the remote */
const BLOB_LIMIT = '1m';

/** a fetch this young serves a status read */
export const FETCH_FRESH_MS = 15_000;

export function mirrorDir(peer: SyndicationPeer): string {
  return wikiDataDir('syndication', `${peer.id}.git`);
}

/** the mirror as git is addressed: by its directory explicitly, so git
 *  never searches upward from it into the site's own repository */
export function mirror(peer: SyndicationPeer): Repo {
  const dir = mirrorDir(peer);
  return { cwd: dir, gitDir: dir };
}

/* ---------------- fetching ---------------- */

/** per mirror: the configuration its refs were last fetched for, and when —
 *  a fetch for another configuration into the same mirror replaces it, so
 *  switching back is never served from the other configuration's refs */
const fetched = new Map<string, { configuration: string; at: number }>();

/** the mirror exists as a bare repository at its own real path inside the
 *  private syndication directory — a symlinked mirror or ancestor would let
 *  git write elsewhere — and points at the configured repository; a
 *  directory at its path that is not a bare repository is refused, never
 *  used as a place to search a repository from */
async function ensureMirror(peer: SyndicationPeer): Promise<Repo> {
  const parent = wikiDataDir('syndication');
  const dir = mirrorDir(peer);
  const repo = mirror(peer);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() || containedPath(parent, `${peer.id}.git`) !== join(realpathSync(parent), `${peer.id}.git`)) {
    throw new Error(`${dir} is not a directory of its own inside ${parent} — a symlink cannot be the mirror`);
  }
  if (!existsSync(dir)) await git(parent, ['init', '--quiet', '--bare', dir]);
  let bare = '';
  try {
    bare = existsSync(join(dir, 'HEAD')) ? (await git(repo, ['rev-parse', '--is-bare-repository'])).trim() : '';
  } catch {
    bare = '';
  }
  if (bare !== 'true') throw new Error(`${dir} is not a bare repository — remove it and the mirror is created again`);
  let url = '';
  try {
    url = (await git(repo, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    await git(repo, ['remote', 'add', 'origin', peer.repo]);
    return repo;
  }
  if (url !== peer.repo) await git(repo, ['remote', 'set-url', 'origin', peer.repo]);
  return repo;
}

/**
 * Fetch the peer's refs into the mirror (a fetch younger than `maxAgeMs`
 * for the same repository, branch and name is reused). Concurrent
 * callers share one fetch. Throws with git's first line.
 */
export async function fetchPeer(peer: SyndicationPeer, name: string, maxAgeMs = 0): Promise<Repo> {
  return withLock(`syndication-fetch:${peer.id}`, async () => {
    const repo = await ensureMirror(peer);
    const configuration = `${peer.repo}\0${peer.branch}\0${name}`;
    const last = fetched.get(mirrorDir(peer));
    if (maxAgeMs > 0 && last?.configuration === configuration && Date.now() - last.at < maxAgeMs) return repo;
    await git(repo, [
      'fetch',
      '--quiet',
      '--prune',
      `--filter=blob:limit=${BLOB_LIMIT}`,
      'origin',
      `+refs/heads/${peer.branch}:refs/peer/base`,
      `+refs/heads/syndicate/${name}/*:refs/peer/staged/*`,
    ]);
    // the verdicts branch exists once the gate has refused something: absent,
    // there are no verdicts
    try {
      await git(repo, ['fetch', '--quiet', `--filter=blob:limit=${BLOB_LIMIT}`, 'origin', `+refs/heads/${VERDICTS_BRANCH}:refs/peer/verdicts`]);
    } catch (err) {
      if (!(err instanceof GitError && /couldn't find remote ref/.test(err.stderr))) throw err;
      await git(repo, ['update-ref', '-d', 'refs/peer/verdicts']);
    }
    fetched.set(mirrorDir(peer), { configuration, at: Date.now() });
    return repo;
  });
}

/* ---------------- content-addressed caches ---------------- */

/** a bounded map that forgets its oldest entries */
class Recent<V> {
  private readonly map = new Map<string, V>();
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
}

/** note blob id → its text (notes are small; blob ids never change meaning) */
const noteTexts = new Recent<string>(8192);
/** staged commit id → the submission it carries */
const stagedCommits = new Recent<{ submission: Submission | null; at: string }>(256);
/** verdict file blob id → its verdict */
const verdicts = new Recent<StoredVerdict | null>(256);

/** `verdict.json` as the gate writes it */
export interface StoredVerdict extends Verdict {
  action?: 'publish' | 'withdraw' | undefined;
  revision?: string | undefined;
}

/** the texts of the given note blobs, reading only the unknown ones */
async function noteTextsOf(repo: Repo, shas: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const sha of new Set(shas)) {
    const cached = noteTexts.get(sha);
    if (cached === undefined) missing.push(sha);
    else out.set(sha, cached);
  }
  for (const [sha, bytes] of await readBlobs(repo, missing)) {
    const text = bytes.toString('utf8');
    noteTexts.set(sha, text);
    out.set(sha, text);
  }
  return out;
}

/* ---------------- the view ---------------- */

export interface PeerCopy {
  unit: string;
  revision: string;
  synced: string;
  /** the digest of the copy as it is on the peer's tip */
  digest: string;
}

export interface PeerView {
  /** the published tip (commit); null when the branch does not exist yet */
  tip: string | null;
  /** the locale prefixes the peer serves ('' first) */
  locales: readonly string[];
  /** the peer's notes under its content directory */
  notes: PeerNoteInfo[];
  /** this wiki's copies there, by unit */
  copies: Map<string, PeerCopy>;
  /** every blob path on the tip (relative to the content directory): a unit
   *  whose directory path is one of them cannot be placed there */
  files: Set<string>;
  /** the origin stamp of each unit's root note file (the first of index.md
   *  / index.mdx in tree order), by unit; null = a root of the peer's own */
  rootOrigins: Map<string, CopyOrigin | null>;
  /** every physical note file inside a unit's directories, by unit —
   *  copies of others', the peer's own, a second root file alike */
  unitFiles: Map<string, Array<{ path: string; origin: string | null }>>;
  /** the staging branches that exist, by unit, whatever their commits say */
  stagedRefs: Set<string>;
  /** submissions awaiting the gate, by unit: the staged commit, what its
   *  trailers say (null when they say nothing readable) and when it was made */
  staged: Map<string, { sha: string; submission: Submission | null; at: string }>;
  /** the gate's refusals, by unit */
  verdicts: Map<string, StoredVerdict>;
}

interface TipReading {
  notes: PeerNoteInfo[];
  copies: Map<string, PeerCopy>;
  files: Set<string>;
  rootOrigins: Map<string, CopyOrigin | null>;
  unitFiles: Map<string, Array<{ path: string; origin: string | null }>>;
}

const tipReadings = new Map<string, { key: string; reading: TipReading }>();

/** the notes and copies on `tip`, read once per tip, content directory,
 *  locale table and origin name */
async function readTip(repo: Repo, peer: SyndicationPeer, name: string, tip: string): Promise<TipReading> {
  const key = [mirrorDir(peer), tip, name, peer.contentDir, peer.locales.join(',')].join('\0');
  const known = tipReadings.get(peer.id);
  if (known?.key === key) return known.reading;
  const entries = (await listTree(repo, tip, peer.contentDir ? peer.contentDir.replace(/\/$/, '') : undefined)).filter((e) =>
    e.path.startsWith(peer.contentDir),
  );
  const relative = (e: TreeEntry): string => e.path.slice(peer.contentDir.length);
  // a note is a regular file: a symlink named index.md is an irregular
  // entry, which digests by its mode and id and never counts as a note
  const noteEntries = entries.filter((e) => isRegularFile(e) && isNoteFile(relative(e)));
  const texts = await noteTextsOf(repo, noteEntries.map((e) => e.sha));
  const locales = peer.locales.map((prefix) => ({ prefix }));

  const notes: PeerNoteInfo[] = [];
  const rootOrigins = new Map<string, CopyOrigin | null>();
  const unitFiles = new Map<string, Array<{ path: string; origin: string | null }>>();
  for (const entry of noteEntries) {
    const rel = relative(entry);
    const id = noteIdOfPath(rel);
    const text = texts.get(entry.sha) ?? '';
    const info = noteInfoFromSource(id, text);
    const fm = splitFrontmatter(text);
    const origin = fm.error ? null : copyOriginOf(fm.data);
    const note: PeerNoteInfo = { ...info, origin: origin?.wiki ?? null };
    // ownership counts every physical note file inside a unit's
    // directories, as the gate reads them; the note list the transform
    // resolves against keeps the scanner's rule for the content root's
    // reserved directories and lists one info per id
    const unit = unitOf(id, locales);
    if (unit) unitFiles.set(unit, [...(unitFiles.get(unit) ?? []), { path: rel, origin: note.origin }]);
    if (id === unit && !rootOrigins.has(id)) rootOrigins.set(id, origin);
    const first = id.split('/')[0]!;
    if (first === '_meta' || first === 'docs' || id.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (!notes.some((n) => n.id === id)) notes.push(note);
  }

  const copies = new Map<string, PeerCopy>();
  for (const [id, origin] of rootOrigins) {
    if (!origin || origin.wiki !== name) continue;
    const parts: Array<[string, string]> = [];
    for (const entry of entries) {
      const rel = relative(entry);
      if (!inUnitRoots(rel, id, peer.locales)) continue;
      parts.push([rel, entryPart(rel, entry.mode, entry.sha, () => texts.get(entry.sha) ?? '')]);
    }
    copies.set(id, { unit: id, revision: origin.revision, synced: origin.synced, digest: digestOfParts(parts) });
  }
  const reading = { notes, copies, files: new Set(entries.map(relative)), rootOrigins, unitFiles };
  tipReadings.set(peer.id, { key, reading });
  return reading;
}

/** the peer as the mirror holds it after the last fetch */
export async function peerView(peer: SyndicationPeer, name: string): Promise<PeerView> {
  const repo = mirror(peer);
  const refs = await listRefs(repo, 'refs/peer/');
  const tip = refs.get('refs/peer/base') ?? null;
  const reading: TipReading = tip ? await readTip(repo, peer, name, tip) : { notes: [], copies: new Map(), files: new Set(), rootOrigins: new Map(), unitFiles: new Map() };

  const stagedRefs = new Set<string>();
  const staged = new Map<string, { sha: string; submission: Submission | null; at: string }>();
  for (const [ref, sha] of refs) {
    const stagedUnit = ref.startsWith('refs/peer/staged/') ? ref.slice('refs/peer/staged/'.length) : null;
    if (!stagedUnit) continue;
    stagedRefs.add(stagedUnit);
    let entry = stagedCommits.get(sha);
    if (!entry) {
      const info = await commitInfo(repo, sha);
      const parsed = parseSubmission(info.message);
      entry = { submission: parsed.ok && parsed.submission.unit === stagedUnit ? parsed.submission : null, at: info.committerDate };
      stagedCommits.set(sha, entry);
    }
    staged.set(stagedUnit, { sha, submission: entry.submission, at: entry.at });
  }
  // the verdicts branch: `<name>/<unit>.json` per refused unit, read by blob id
  const found = new Map<string, StoredVerdict>();
  const verdictsTip = refs.get('refs/peer/verdicts');
  if (verdictsTip) {
    for (const entry of await listTree(repo, verdictsTip, name)) {
      const m = new RegExp(`^${name}/([^/]+)\\.json$`).exec(entry.path);
      if (!m || !isRegularFile(entry)) continue;
      let verdict = verdicts.get(entry.sha);
      if (verdict === undefined) {
        verdict = await readVerdict(repo, entry.sha);
        verdicts.set(entry.sha, verdict);
      }
      if (verdict) found.set(m[1]!, verdict);
    }
  }
  return { tip, locales: peer.locales, ...reading, stagedRefs, staged, verdicts: found };
}

async function readVerdict(repo: Repo, blob: string): Promise<StoredVerdict | null> {
  try {
    const text = (await readBlobs(repo, [blob])).get(blob)?.toString('utf8') ?? '';
    const value = JSON.parse(text) as Partial<StoredVerdict>;
    if (typeof value.staged !== 'string' || !Array.isArray(value.problems) || typeof value.at !== 'string') return null;
    return {
      staged: value.staged,
      ok: false,
      code: value.code,
      problems: value.problems.filter((p): p is string => typeof p === 'string'),
      at: value.at,
      action: value.action === 'withdraw' ? 'withdraw' : value.action === 'publish' ? 'publish' : undefined,
      revision: typeof value.revision === 'string' ? value.revision : undefined,
    };
  } catch {
    return null;
  }
}

/* ---------------- what the view says about a unit ---------------- */

/** the path of the unit's directory, in any locale, that is a file on the
 *  peer's tip — nothing can be placed at such a unit, adopted or not */
export function fileAtUnitRoot(view: PeerView, unit: string): string | null {
  return unitRoots(unit, view.locales).find((root) => view.files.has(root)) ?? null;
}

/** the unit's state on the peer's tip; a file at the unit's path is the peer's own (native) */
export function unitState(view: PeerView, unit: string, name: string): UnitState {
  if (fileAtUnitRoot(view, unit) !== null) return { kind: 'native' };
  const copy = view.copies.get(unit);
  const files = view.unitFiles.get(unit) ?? [];
  const rootFile = [`${unit}/index.md`, `${unit}/index.mdx`].find((p) => files.some((f) => f.path === p));
  const rootOrigin = view.rootOrigins.get(unit);
  return unitStateFrom({
    rootOrigin: rootFile === undefined ? undefined : rootOrigin ? { wiki: rootOrigin.wiki, revision: rootOrigin.revision } : null,
    // every other physical note file, a second root file included
    insideOrigins: files.filter((f) => f.path !== rootFile).map((f) => f.origin),
    digest: copy?.digest ?? '',
    name,
  });
}

/** the submission the peer has not accepted: pending while its staging
 *  branch exists, rejected while a verdict stands that no later accepted
 *  copy supersedes (the gate deletes a verdict when it promotes; a copy
 *  synced after the verdict was written outranks one it left behind) */
export function submissionOf(view: PeerView, unit: string): SyndicationSubmission | undefined {
  const staged = view.staged.get(unit);
  if (staged) {
    // a staging branch whose commit says nothing readable is still a
    // submission the gate has to deal with
    return { action: staged.submission?.action ?? 'publish', state: 'pending', revision: staged.submission?.revision, at: staged.at, commit: staged.sha };
  }
  const verdict = view.verdicts.get(unit);
  if (!verdict) return undefined;
  const copy = view.copies.get(unit);
  if (copy && Date.parse(copy.synced) > Date.parse(verdict.at)) return undefined;
  return {
    action: verdict.action ?? 'publish',
    state: 'rejected',
    revision: verdict.revision,
    at: verdict.at,
    problems: verdict.problems,
    code: verdict.code,
    commit: verdict.staged,
  };
}

/** the repo-relative directories of a unit on the peer */
export function peerUnitRoots(peer: SyndicationPeer, unit: string): string[] {
  return unitRoots(unit, peer.locales).map((root) => `${peer.contentDir}${root}`);
}
