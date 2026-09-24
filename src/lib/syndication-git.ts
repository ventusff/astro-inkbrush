/**
 * syndication-git — the git plumbing syndication runs on, shared by the
 * origin server (against its bare mirror of a peer) and the peer's gate
 * script (inside a checkout). Every command is `execFile` with an argument
 * array — never a shell — with GIT_TERMINAL_PROMPT off, so a repository
 * that needs credentials the environment does not provide fails at once
 * instead of hanging on a prompt. Trees are built in a temporary index
 * (GIT_INDEX_FILE), which works in a bare repository: read the base tree,
 * drop the paths under the unit's directories, add the new blobs, write
 * the tree — so a commit is a declarative "this directory is now these
 * files" on top of whatever tip the peer has.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { digestOfParts, entryPart, inUnitRoots, isFileMode, isNoteFile, noteIdOfPath, unitPathProblem } from './syndication-bundle.ts';

/** a failed git command: `stderr` in full, `summary` its first non-empty
 *  line without surrounding whitespace (ssh writes CRLF line ends) */
export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly summary: string;
  constructor(args: readonly string[], stderr: string) {
    const summary = stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? `git ${args[0]} failed`;
    super(summary.replace(/^(fatal|error): /, ''));
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.summary = summary;
  }
}

export interface GitOptions {
  /** fed to stdin */
  input?: string | Uint8Array | undefined;
  /** laid over the process environment */
  env?: Record<string, string | undefined> | undefined;
}

/** where git runs: a working directory git discovers its repository from
 *  (a checkout), or a repository named explicitly — git then never
 *  searches upward from the directory, which is what a bare mirror inside
 *  another repository's tree needs */
export type Repo = string | { cwd: string; gitDir: string };

const OUTPUT_LIMIT = 256 * 1024 * 1024;

/** run git in `repo`; resolves with stdout as bytes, rejects with a GitError */
export function gitBytes(repo: Repo, args: string[], options: GitOptions = {}): Promise<Buffer> {
  const cwd = typeof repo === 'string' ? repo : repo.cwd;
  const argv = typeof repo === 'string' ? args : [`--git-dir=${repo.gitDir}`, ...args];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      argv,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
        encoding: 'buffer',
        maxBuffer: OUTPUT_LIMIT,
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr.toString('utf8') || error.message));
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** run git in `repo`; resolves with stdout as text */
export async function git(repo: Repo, args: string[], options: GitOptions = {}): Promise<string> {
  return (await gitBytes(repo, args, options)).toString('utf8');
}

/* ---------------- reading ---------------- */

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** repo-relative path */
  path: string;
}

/** every entry under `treeish` (recursive), optionally below one path */
export async function listTree(repo: Repo, treeish: string, below?: string): Promise<TreeEntry[]> {
  const out = await git(repo, ['ls-tree', '-r', '-z', treeish, ...(below ? ['--', below] : [])]);
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const m = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.*)$/s.exec(record);
    if (m) entries.push({ mode: m[1]!, type: m[2] as TreeEntry['type'], sha: m[3]!, path: m[4]! });
  }
  return entries;
}

/** the contents of the named blobs, in one batch */
export async function readBlobs(repo: Repo, shas: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (shas.length === 0) return out;
  const bytes = await gitBytes(repo, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n` });
  let at = 0;
  while (at < bytes.length) {
    const eol = bytes.indexOf(0x0a, at);
    const header = bytes.subarray(at, eol).toString('utf8');
    const m = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!m) throw new Error(`git cat-file: ${header}`);
    const size = Number(m[2]);
    out.set(m[1]!, Buffer.from(bytes.subarray(eol + 1, eol + 1 + size)));
    at = eol + 1 + size + 1;
  }
  return out;
}

/** refs below `prefix` (`refs/peer/`) → object id */
export async function listRefs(repo: Repo, prefix: string): Promise<Map<string, string>> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', prefix]);
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, sha] = line.split('\0');
    if (name && sha) refs.set(name, sha);
  }
  return refs;
}

export async function revParse(repo: Repo, rev: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 */
  authorDate: string;
  committerDate: string;
  parents: string[];
}

export async function commitInfo(repo: Repo, sha: string): Promise<CommitInfo> {
  const out = await git(repo, ['log', '-1', '--format=%H%x00%an%x00%ae%x00%aI%x00%cI%x00%P%x00%B', sha]);
  const [id, authorName, authorEmail, authorDate, committerDate, parents, message] = out.split('\0');
  return {
    sha: id!,
    message: message ?? '',
    authorName: authorName!,
    authorEmail: authorEmail!,
    authorDate: authorDate!,
    committerDate: committerDate!,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
  };
}

/** a tree entry that is a file of the unit: a blob in a regular file's mode, plain or executable */
export function isRegularFile(entry: TreeEntry): boolean {
  return entry.type === 'blob' && isFileMode(entry.mode);
}

/**
 * A unit's files in a tree: its entries under the unit's directories
 * (below `contentDir`), the texts of its regular note files, its digest
 * (every entry by the bundle's part rule, from its mode and blob id),
 * and every problem that makes it no unit an origin could have sent — an
 * entry that is not a regular file (a symlink, a submodule), a
 * dot-prefixed segment, a note directory holding both index.md and
 * index.mdx.
 */
export async function readUnitInTree(
  repo: Repo,
  treeish: string,
  contentDir: string,
  unit: string,
  prefixes: readonly string[],
): Promise<{ entries: TreeEntry[]; noteTexts: Map<string, string>; digest: string; problems: string[] }> {
  const entries = (await listTree(repo, treeish, contentDir ? contentDir.replace(/\/$/, '') : undefined)).filter(
    (e) => e.path.startsWith(contentDir) && inUnitRoots(e.path.slice(contentDir.length), unit, prefixes),
  );
  const rel = (e: TreeEntry): string => e.path.slice(contentDir.length);
  const problems: string[] = [];
  const noteDirs = new Map<string, number>();
  for (const e of entries) {
    if (!isRegularFile(e)) problems.push(`${rel(e)}: not a regular file (mode ${e.mode})`);
    const dotted = unitPathProblem(rel(e));
    if (dotted) problems.push(dotted);
    if (isRegularFile(e) && isNoteFile(rel(e))) noteDirs.set(noteIdOfPath(rel(e)), (noteDirs.get(noteIdOfPath(rel(e))) ?? 0) + 1);
  }
  for (const [id, count] of noteDirs) {
    if (count > 1) problems.push(`${id}/index.mdx: both index.md and index.mdx exist — one note cannot have two sources`);
  }
  const notes = entries.filter((e) => isRegularFile(e) && isNoteFile(rel(e)));
  const blobs = await readBlobs(repo, notes.map((e) => e.sha));
  const noteTexts = new Map(notes.map((e) => [rel(e), blobs.get(e.sha)!.toString('utf8')]));
  const parts = entries.map((e): [string, string] => [rel(e), entryPart(rel(e), e.mode, e.sha, () => noteTexts.get(rel(e))!)]);
  return { entries, noteTexts, digest: digestOfParts(parts), problems };
}

/** the paths that differ between two trees (or commits); `from` null = an empty tree */
export async function changedPaths(repo: Repo, from: string | null, to: string): Promise<string[]> {
  const base = from ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  return (await git(repo, ['diff', '--name-only', '-z', base, to])).split('\0').filter(Boolean);
}

/* ---------------- writing ---------------- */

/**
 * Write `files` (path → bytes) as blobs into the repository through a
 * scratch directory (`git hash-object --stdin-paths` reads them in one
 * process, without clean filters — the stored blob is the bytes the
 * digest saw); returns path → blob id. A blob has no mode: the tree entry
 * that names it carries one (buildTree). The scratch directory is removed.
 */
export async function writeBlobs(repo: Repo, files: ReadonlyMap<string, Uint8Array>, scratchDir: string): Promise<Map<string, string>> {
  const paths = [...files.keys()].sort();
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  try {
    for (const path of paths) {
      const abs = join(scratchDir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, files.get(path)!);
    }
    const ids = (await git(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: `${paths.map((p) => join(scratchDir, p)).join('\n')}\n` }))
      .trim()
      .split('\n');
    paths.forEach((path, i) => out.set(path, ids[i]!));
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  return out;
}

export interface TreeChange {
  /** the tree (or commit) to start from; null starts empty */
  base: string | null;
  /** directories whose entries are dropped (repo-relative, no trailing slash) */
  remove: readonly string[];
  /** entries written after the removal, each in its git mode */
  add: ReadonlyArray<{ path: string; sha: string; mode: string }>;
  /** the temporary index file to build in (removed afterwards) */
  indexFile: string;
}

/** the id of the tree `base` becomes after the change */
export async function buildTree(repo: Repo, change: TreeChange): Promise<string> {
  const env = { GIT_INDEX_FILE: change.indexFile };
  rmSync(change.indexFile, { force: true });
  try {
    if (change.base) await git(repo, ['read-tree', change.base], { env });
    const lines: string[] = [];
    if (change.base) {
      for (const prefix of change.remove) {
        for (const entry of await listTree(repo, change.base, prefix)) {
          lines.push(`0 0000000000000000000000000000000000000000\t${entry.path}`);
        }
      }
    }
    for (const entry of change.add) lines.push(`${entry.mode} blob ${entry.sha}\t${entry.path}`);
    if (lines.length > 0) await git(repo, ['update-index', '-z', '--index-info'], { env, input: `${lines.join('\0')}\0` });
    return (await git(repo, ['write-tree'], { env })).trim();
  } finally {
    rmSync(change.indexFile, { force: true });
  }
}

export interface Identity {
  name: string;
  email: string;
  /** ISO 8601 or git's own format; absent = now */
  date?: string | undefined;
}

/** a commit of `tree` with the given author; the committer is the
 *  environment's git identity unless one is given */
export async function commitTree(repo: Repo,
  opts: { tree: string; parents: readonly string[]; message: string; author: Identity; committer?: Identity | undefined },
): Promise<string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: opts.author.name,
    GIT_AUTHOR_EMAIL: opts.author.email,
    ...(opts.author.date ? { GIT_AUTHOR_DATE: opts.author.date } : {}),
    ...(opts.committer
      ? {
          GIT_COMMITTER_NAME: opts.committer.name,
          GIT_COMMITTER_EMAIL: opts.committer.email,
          ...(opts.committer.date ? { GIT_COMMITTER_DATE: opts.committer.date } : {}),
        }
      : {}),
  };
  const parents = opts.parents.flatMap((p) => ['-p', p]);
  return (await git(repo, ['commit-tree', opts.tree, ...parents, '-F', '-'], { env, input: opts.message })).trim();
}

/** the committer identity git would use in `repo`, or null when it has none */
export async function committerIdentity(repo: Repo): Promise<Identity | null> {
  try {
    const ident = (await git(repo, ['var', 'GIT_COMMITTER_IDENT'])).trim();
    const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(ident);
    return m ? { name: m[1]!, email: m[2]! } : null;
  } catch {
    return null;
  }
}

/** push one refspec; `force` overwrites the destination */
export async function push(repo: Repo, remote: string, refspec: string, force = false): Promise<void> {
  await git(repo, ['push', '--quiet', ...(force ? ['--force'] : []), remote, refspec]);
}

/** delete a ref on the remote; a ref that is already gone is not an error */
export async function pushDelete(repo: Repo, remote: string, ref: string): Promise<void> {
  try {
    await git(repo, ['push', '--quiet', remote, '--delete', ref]);
  } catch (err) {
    if (!(err instanceof GitError && /remote ref does not exist|unable to delete/.test(err.stderr))) throw err;
  }
}
