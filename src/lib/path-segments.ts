/**
 * Path-segment predicates for filters that receive native paths (the inbox
 * watcher hands back `\`-separated paths on Windows) but are configured
 * with `/`-spelled entries. Comparing whole segments — never substrings —
 * keeps `_assets` from matching `_assets-backup`. Free of server imports
 * so the predicates stay unit-testable.
 */

/** the path's segments, split on either separator; empty segments (doubled
 *  separators, a leading `/`) are dropped */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** whether any segment of `path` equals `name` */
export function hasPathSegment(path: string, name: string): boolean {
  return pathSegments(path).includes(name);
}

/** the path spelled with `/` separators (for state keys and config
 *  prefix comparison) */
export function toPosixPath(path: string): string {
  return pathSegments(path).join('/');
}
