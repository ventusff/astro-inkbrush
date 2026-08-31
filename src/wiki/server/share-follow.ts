/**
 * A share follows its note: the published snapshot is republished when the
 * note changes — but only after the note has been quiet for a while (an
 * editing session ends; each block save is not a version) — unless the
 * share is pinned. The pure pieces live here: the snapshot fingerprint that
 * decides whether an upload is needed, the due predicate, and the loop
 * that runs due publishes one at a time.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Snapshot } from './snapshot.ts';

/** sha256 over the snapshot's files (index.html and the asset closure), by
 *  sorted path — the same page bytes give the same fingerprint whatever
 *  order the closure was collected in */
export function snapshotFingerprint(snapshot: Snapshot): string {
  const hash = createHash('sha256');
  for (const rel of ['index.html', ...snapshot.files].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(snapshot.dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface FollowCandidate {
  pinned: boolean;
  /** ISO time of the published version */
  publishedAt: string;
  /** newest mtime (ms) under the note's source directory; null = no source */
  noteChangedAt: number | null;
}

/** the share needs a republish now: not pinned, the note changed after the
 *  published version, and nothing under it changed for `idleMs` */
export function followDue(share: FollowCandidate, now: number, idleMs: number): boolean {
  if (share.pinned || share.noteChangedAt === null) return false;
  if (share.noteChangedAt <= Date.parse(share.publishedAt)) return false;
  return now - share.noteChangedAt >= idleMs;
}

export interface FollowerOptions<T> {
  /** how often due shares are looked for (ms) */
  intervalMs?: number;
  /** the shares due right now */
  due: () => T[];
  /** republish one share; a rejection is logged and the share is retried at
   *  a later probe */
  publish: (share: T) => Promise<void>;
  describe: (share: T) => string;
  log: (message: string) => void;
}

/**
 * Runs due publishes one at a time: a probe that finds work publishes each
 * due share in turn and never overlaps with itself. The returned function
 * stops the loop.
 */
export function startShareFollower<T>(opts: FollowerOptions<T>): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const share of opts.due()) {
        const label = opts.describe(share);
        try {
          await opts.publish(share);
          opts.log(`${label}: republished — the note changed`);
        } catch (err) {
          opts.log(`${label}: republish failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
