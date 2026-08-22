/**
 * A throwaway working copy for an AI job. The job runs in a temporary
 * directory that mirrors the project's layout but holds only the files the
 * job is allowed to see; when the job ends, the copy is diffed against a
 * baseline snapshot taken at creation, and only changes to allowed paths are
 * carried back — after the caller has validated them. Nothing the job does
 * in the copy reaches the project otherwise, and the copy is removed
 * afterwards.
 *
 * Containment contract:
 *  - every scope entry must be a non-empty relative path with no `..`
 *    segment that resolves inside the project root; a violating entry fails
 *    workspace creation before any copy;
 *  - an entry that lies inside another entry is dropped (deduplication);
 *  - copying and walking use lstat and skip symlinks, so a link cannot
 *    smuggle host files into the copy;
 *  - apply() re-verifies every target: its real path (symlinks resolved)
 *    must lie inside a scoped root, so a write can never land outside the
 *    scope or pass through a link.
 *
 * Conflict contract: apply() holds the in-process write locks of all target
 * files (sorted path order) and verifies each still matches the creation
 * baseline; any mismatch refuses the whole application with nothing
 * written. A write failure midway reports exactly which files were and were
 * not written.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { containedPath, realpathDeep } from './paths.ts';
import { projectRoot, withLock, writeFileAtomic } from './store.ts';

export interface WorkspaceChange {
  /** project-relative path */
  rel: string;
  /** new content; null when the job deleted the file */
  content: string | null;
}

export interface Workspace {
  /** absolute path of the copy; the job's working directory */
  dir: string;
  /** project-relative paths (files or directories) the copy contains and the job may change */
  scope: string[];
  /** every file that differs from the creation baseline, within scope */
  changes(): WorkspaceChange[];
  /** the project file's content at workspace creation; null = did not exist */
  baseline(rel: string): string | null;
  /** verify containment and baselines under the file locks, then write */
  apply(changes: WorkspaceChange[]): Promise<void>;
  destroy(): void;
}

/** the file's content when `base/rel` is a regular file (symlinks excluded); null otherwise */
function fileContent(base: string, rel: string): string | null {
  const abs = join(base, rel);
  try {
    if (!lstatSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(abs, 'utf8');
}

/** every regular file at or under `base/rel` (symlinks skipped), relative to `base` */
function filesUnder(base: string, rel: string): string[] {
  const abs = join(base, rel);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() || entry.isFile()) out.push(...filesUnder(base, join(rel, entry.name)));
  }
  return out;
}

/** copy `src` into `dst`: files copied, directories recursed, symlinks skipped */
function copyTree(src: string, dst: string): void {
  const stat = lstatSync(src);
  if (stat.isFile()) {
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(src, dst);
    return;
  }
  if (!stat.isDirectory()) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    if (entry.isSymbolicLink()) continue;
    copyTree(join(src, entry.name), join(dst, entry.name));
  }
}

/** `rel` is `scopeEntry` itself or lies beneath it */
const within = (rel: string, scopeEntry: string): boolean =>
  rel === scopeEntry || rel.startsWith(scopeEntry.endsWith(sep) ? scopeEntry : scopeEntry + sep);

/** normalize and validate scope entries; throws on a violating entry */
function resolveScope(root: string, scope: string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of scope) {
    const entry = raw.replace(/\/+$/, '');
    if (!entry.trim()) throw new Error(`AI job scope entry is empty ('${raw}')`);
    if (isAbsolute(entry)) throw new Error(`AI job scope entry must be relative: '${raw}'`);
    if (entry.split(/[\\/]/).some((seg) => seg === '..')) {
      throw new Error(`AI job scope entry must not contain '..': '${raw}'`);
    }
    if (!containedPath(root, entry)) {
      throw new Error(`AI job scope entry escapes the project root: '${raw}'`);
    }
    cleaned.push(entry);
  }
  // shortest first, so a containing entry is kept and its children dropped
  cleaned.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const deduped: string[] = [];
  for (const entry of cleaned) {
    if (!deduped.some((kept) => within(entry, kept))) deduped.push(entry);
  }
  return deduped;
}

/**
 * Create the copy. `scope` lists project-relative files or directories: each
 * existing one is copied in (a directory recursively, without node_modules
 * and without symlinks); a directory that does not exist yet is created
 * empty, so the job can write a new note into it. Every in-scope project
 * file's content is recorded as the baseline the job's changes are computed
 * and verified against.
 */
export function createWorkspace(scope: string[]): Workspace {
  const root = projectRoot();
  const scoped = resolveScope(root, scope);
  const dir = join(tmpdir(), `inkbrush-job-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });

  const baseline = new Map<string, string>();
  for (const entry of scoped) {
    for (const rel of filesUnder(root, entry)) {
      const content = fileContent(root, rel);
      if (content !== null) baseline.set(rel, content);
    }
  }
  for (const rel of scoped) {
    const src = resolve(root, rel);
    const dst = join(dir, rel);
    try {
      lstatSync(src);
    } catch {
      mkdirSync(dst, { recursive: true });
      continue;
    }
    copyTree(src, dst);
  }

  return {
    dir,
    scope: scoped,
    baseline(rel) {
      return baseline.get(rel) ?? null;
    },
    changes() {
      const seen = new Set<string>();
      const out: WorkspaceChange[] = [];
      for (const entry of scoped) {
        const candidates = [
          ...filesUnder(dir, entry),
          ...[...baseline.keys()].filter((rel) => within(rel, entry)),
        ];
        for (const rel of candidates) {
          if (seen.has(rel) || !scoped.some((s) => within(rel, s))) continue;
          seen.add(rel);
          const before = baseline.get(rel) ?? null;
          const after = fileContent(dir, rel);
          if (before !== after) out.push({ rel, content: after });
        }
      }
      return out;
    },
    async apply(changes) {
      // containment first: every target's real path must sit inside a scoped root
      const scopeRootsReal = scoped.map((s) => realpathDeep(resolve(root, s)));
      const targets = new Map<string, WorkspaceChange>();
      for (const change of changes) {
        const inScope = scoped.some((s) => within(change.rel, s));
        const real = inScope ? containedPath(root, change.rel) : null;
        const inRoots =
          real !== null && scopeRootsReal.some((sr) => real === sr || real.startsWith(sr + sep));
        if (!inRoots) {
          throw new Error(`Refused: change outside the job's scope: '${change.rel}' — nothing was written`);
        }
        targets.set(real!, change);
      }
      const keys = [...targets.keys()].sort();
      const run = async (): Promise<void> => {
        // all baselines verified before any write
        for (const change of targets.values()) {
          const live = fileContent(root, change.rel);
          const base = baseline.get(change.rel) ?? null;
          if (live !== base) {
            throw new Error(
              `Conflict: '${change.rel}' was modified while the job ran — nothing was written`,
            );
          }
        }
        const written: string[] = [];
        for (const [abs, change] of targets) {
          try {
            if (change.content === null) rmSync(abs, { force: true });
            else writeFileAtomic(abs, change.content);
            written.push(change.rel);
          } catch (err) {
            const pending = [...targets.values()].map((c) => c.rel).filter((r) => !written.includes(r));
            throw new Error(
              `Write failed at '${change.rel}': ${(err as Error).message}. ` +
                `Written: ${written.length ? written.join(', ') : '(none)'}; ` +
                `not written: ${pending.join(', ')}`,
            );
          }
        }
      };
      // nested acquisition in sorted order keeps lock ordering deadlock-free
      const locked = keys.reduceRight<() => Promise<void>>(
        (next, key) => () => withLock(key, next),
        run,
      );
      await locked();
    },
    destroy() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
