/**
 * Filesystem containment. Every path the CMS reads or writes on behalf of a
 * request is resolved to a real path (symlinks followed) and must lie inside
 * its root, compared component-wise — a prefix match on strings would let
 * `/root-other` pass as `/root`, and a symlink inside the root pointing
 * elsewhere would escape it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** real path of `path`, or of its nearest existing ancestor joined with the rest */
export function realpathDeep(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return resolve(realpathDeep(parent), abs.slice(parent.length + 1));
}

/** true when `path` equals `root` or is a descendant of it (both real paths) */
export function isWithin(root: string, path: string): boolean {
  const r = realpathDeep(root);
  const p = realpathDeep(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve `candidate` (absolute, or relative to `root`) and return its real
 * path when it lies inside `root`; null otherwise.
 */
export function containedPath(root: string, candidate: string): string | null {
  const abs = resolve(root, candidate);
  return isWithin(root, abs) ? realpathDeep(abs) : null;
}
