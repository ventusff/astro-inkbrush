/**
 * Flat-file persistence for the wiki: everything lives under `.wiki/` at the
 * repo root (git-ignored). No database — revisions and comments are
 * append-only NDJSON, small state is JSON, the session secret is a generated
 * file.
 *
 * Durability contract:
 *  - a JSON file is written atomically (temp file + rename), so a reader
 *    sees the old or the new content, never a torn file;
 *  - a file that exists but does not parse is an error, never an empty
 *    value — the next write would otherwise erase recoverable state;
 *  - an NDJSON file tolerates exactly one torn record, its last line (a
 *    crash mid-append); a malformed line anywhere else is an error;
 *  - read-modify-write sequences on one file run under `withLock(file)`,
 *    which serializes them within this process (the CMS runs as one dev
 *    server process; there is no cross-process lock);
 *  - `.wiki/` holds private state (session secret, journals, comments):
 *    its directories are created 0700 and its new files 0600; an existing
 *    file keeps its mode on rewrite; content files elsewhere keep the
 *    process default.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

let root = process.cwd();

/** called once by the middleware entry with the astro project root */
export function setProjectRoot(dir: string): void {
  root = dir;
}

export function projectRoot(): string {
  return root;
}

export function wikiDataDir(...segments: string[]): string {
  return join(root, '.wiki', 'data', ...segments);
}

/** `path` sits under this project's private `.wiki/` state directory */
function underWikiDir(path: string): boolean {
  const wikiRoot = join(root, '.wiki');
  return path === wikiRoot || path.startsWith(wikiRoot + sep);
}

function ensureDir(path: string, mode?: number): void {
  mkdirSync(path, { recursive: true, ...(mode === undefined ? {} : { mode }) });
}

/** write `text` to `file` atomically: a sibling temp file, fsync, rename;
 *  a failed write removes the temp file, and the directory entry is fsynced
 *  (best-effort) so the rename survives a crash. An existing file keeps its
 *  mode; a new file under `.wiki/` defaults to 0600 (and its directories to
 *  0700), a new file elsewhere to `mode` or the process default */
export function writeFileAtomic(file: string, text: string, mode?: number): void {
  const isPrivate = underWikiDir(file);
  ensureDir(dirname(file), isPrivate ? 0o700 : undefined);
  let effectiveMode = mode ?? (isPrivate ? 0o600 : undefined);
  try {
    effectiveMode = statSync(file).mode & 0o777;
  } catch {
    /* new file — the default above applies */
  }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, 'w', effectiveMode);
    try {
      // the open mode is filtered by the umask; a preserved/explicit mode
      // must land exactly, so it is applied to the descriptor as well
      if (effectiveMode !== undefined) fchmodSync(fd, effectiveMode);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file never created or already gone */
    }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(file), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* directory fsync is best-effort (not every fs supports it) */
  }
}

/* ---------------- in-process lock ---------------- */

const locks = new Map<string, Promise<void>>();

/**
 * Run `fn` while holding the lock named `key` (a file path by convention).
 * Callers queue in order; the lock is released when `fn` settles, whether it
 * resolved or threw.
 */
export async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => held);
  locks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

/* ---------------- session secret ---------------- */

/** HMAC secret for session cookies, generated on first run; creation is
 *  exclusive, so two concurrent first requests share one secret */
export function sessionSecret(): string {
  const file = join(root, '.wiki', 'secret');
  if (!existsSync(file)) {
    ensureDir(dirname(file), 0o700);
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return readFileSync(file, 'utf8').trim();
}

/* ---------------- JSON / NDJSON ---------------- */

export function appendNdjson(file: string, record: unknown): void {
  const isPrivate = underWikiDir(file);
  ensureDir(dirname(file), isPrivate ? 0o700 : undefined);
  // the mode applies only when the append creates the file
  appendFileSync(file, `${JSON.stringify(record)}\n`, isPrivate ? { mode: 0o600 } : {});
}

export function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch (err) {
      const isTail = lines.slice(i + 1).every((l) => l.trim() === '');
      if (isTail) break;
      throw new Error(`${file}:${i + 1}: malformed record — ${(err as Error).message}`);
    }
  }
  return out;
}

/** parse a JSON file; a missing file is `fallback`, an unparsable one an error */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    throw new Error(`${file}: unreadable or not JSON — ${(err as Error).message}`);
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** a note id as a file-name segment: reversible, collision-free
 *  (`a/b` and `a__b` stay distinct) */
export function noteKey(id: string): string {
  return encodeURIComponent(id);
}
