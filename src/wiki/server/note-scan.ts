/**
 * The /notes scanner, keyed by the content root it scans. The project root
 * is pinned per request (setProjectRoot), so the scanner must bind to the
 * root current at request time, not at module load — a scanner created
 * before the root is pinned would keep scanning the wrong tree. Kept free
 * of config/server imports so the keying rule is unit-testable.
 */
import { cachedScan, type WikiNoteInfo } from '../../lib/wikilinks.ts';

/**
 * A note-list reader keyed by content root: the underlying short-TTL scan
 * cache is reused while the root stays the same and discarded when it
 * changes.
 */
export function createRootedScanner(): (contentRoot: string) => WikiNoteInfo[] {
  let current: { root: string; scan: () => WikiNoteInfo[] } | null = null;
  return (contentRoot) => {
    if (!current || current.root !== contentRoot) {
      current = { root: contentRoot, scan: cachedScan(contentRoot) };
    }
    return current.scan();
  };
}
