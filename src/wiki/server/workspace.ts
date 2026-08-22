/**
 * A throwaway working copy for an AI job. The job runs in a temporary
 * directory that mirrors the project's layout but holds only the files the
 * job is allowed to see; when the job ends, the copy is diffed against the
 * project and only changes to allowed paths are carried back — after the
 * caller has validated them. Nothing the job does in the copy reaches the
 * project otherwise, and the copy is removed afterwards.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { projectRoot, writeFileAtomic } from './store.ts';

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
  /** every file that differs from the project, within scope */
  changes(): WorkspaceChange[];
  /** write the given changes into the project, atomically per file */
  apply(changes: WorkspaceChange[]): void;
  destroy(): void;
}

/** every file at or under `base/rel`, as paths relative to `base` */
function filesUnder(base: string, rel: string): string[] {
  const abs = join(base, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    if (entry.isDirectory() || entry.isFile()) out.push(...filesUnder(base, join(rel, entry.name)));
  }
  return out;
}

/** `rel` is `scopeEntry` itself or lies beneath it */
const within = (rel: string, scopeEntry: string): boolean =>
  rel === scopeEntry || rel.startsWith(scopeEntry.endsWith(sep) ? scopeEntry : scopeEntry + sep);

/**
 * Create the copy. `scope` lists project-relative files or directories: each
 * existing one is copied in (a directory recursively, without node_modules);
 * a directory that does not exist yet is created empty, so the job can
 * write a new note into it.
 */
export function createWorkspace(scope: string[]): Workspace {
  const root = projectRoot();
  const dir = join(tmpdir(), `inkbrush-job-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const scoped = scope.map((s) => s.replace(/\/+$/, ''));
  for (const rel of scoped) {
    const src = resolve(root, rel);
    const dst = join(dir, rel);
    if (existsSync(src)) {
      cpSync(src, dst, {
        recursive: true,
        filter: (p) => !p.split(sep).some((seg) => seg === 'node_modules' || seg.startsWith('.git')),
      });
    } else {
      mkdirSync(dst, { recursive: true });
    }
  }

  const snapshot = (base: string, rel: string): string | null => {
    const abs = join(base, rel);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  };

  return {
    dir,
    scope: scoped,
    changes() {
      const seen = new Set<string>();
      const out: WorkspaceChange[] = [];
      for (const entry of scoped) {
        for (const rel of [...filesUnder(dir, entry), ...filesUnder(root, entry)]) {
          if (seen.has(rel) || !scoped.some((s) => within(rel, s))) continue;
          seen.add(rel);
          const before = snapshot(root, rel);
          const after = snapshot(dir, rel);
          if (before !== after) out.push({ rel, content: after });
        }
      }
      return out;
    },
    apply(changes) {
      for (const change of changes) {
        const abs = resolve(root, change.rel);
        if (change.content === null) rmSync(abs, { force: true });
        else writeFileAtomic(abs, change.content);
      }
    },
    destroy() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
