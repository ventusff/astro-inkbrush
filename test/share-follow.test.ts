/**
 * A share follows its note: the snapshot fingerprint that decides whether
 * an upload is needed, the due predicate, and the follower loop.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { followDue, snapshotFingerprint, startShareFollower } from '../src/wiki/server/share-follow.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function snapshot(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-fp-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return { dir, files: Object.keys(files).filter((f) => f !== 'index.html') };
}

test('the fingerprint depends on the bytes, not on collection order', () => {
  const a = snapshot({ 'index.html': '<p>a</p>', '_astro/x.css': 'x', '_astro/y.js': 'y' });
  const b = snapshot({ 'index.html': '<p>a</p>', '_astro/y.js': 'y', '_astro/x.css': 'x' });
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b));
  const c = snapshot({ 'index.html': '<p>changed</p>', '_astro/x.css': 'x', '_astro/y.js': 'y' });
  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(c));
  const d = snapshot({ 'index.html': '<p>a</p>', '_astro/x.css': 'x', '_astro/y.js': 'y2' });
  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(d));
});

test('a share is due once its note changed after the published version and went quiet', () => {
  const now = 1_000_000_000_000;
  const idle = 20 * 60_000;
  const publishedAt = new Date(now - 3 * 60 * 60_000).toISOString();
  // changed an hour ago → quiet long enough
  assert.equal(followDue({ pinned: false, publishedAt, noteChangedAt: now - 60 * 60_000 }, now, idle), true);
  // changed a minute ago → still an editing session
  assert.equal(followDue({ pinned: false, publishedAt, noteChangedAt: now - 60_000 }, now, idle), false);
  // changed before the published version → nothing new
  assert.equal(followDue({ pinned: false, publishedAt, noteChangedAt: now - 4 * 60 * 60_000 }, now, idle), false);
  // pinned → never
  assert.equal(followDue({ pinned: true, publishedAt, noteChangedAt: now - 60 * 60_000 }, now, idle), false);
  // no source any more → never
  assert.equal(followDue({ pinned: false, publishedAt, noteChangedAt: null }, now, idle), false);
  // idle 0 = publish as soon as the change is seen
  assert.equal(followDue({ pinned: false, publishedAt, noteChangedAt: now }, now, 0), true);
});

test('the follower publishes due shares one at a time and reports each', async () => {
  const published: string[] = [];
  const logs: string[] = [];
  let pending = ['a', 'b'];
  const stop = startShareFollower<string>({
    intervalMs: 5,
    due: () => pending,
    publish: async (id) => {
      pending = pending.filter((x) => x !== id);
      await sleep(10);
      if (id === 'b') throw new Error('gateway said no');
      published.push(id);
    },
    describe: (id) => `note-${id}`,
    log: (m) => logs.push(m),
  });
  await sleep(120);
  stop();
  assert.deepEqual(published, ['a']);
  assert.ok(logs.some((m) => m.startsWith('note-a: republished')));
  assert.ok(logs.some((m) => m.startsWith('note-b: republish failed — gateway said no')));
});

test('a probe never overlaps with a running one', async () => {
  let active = 0;
  let maxActive = 0;
  const stop = startShareFollower<number>({
    intervalMs: 2,
    due: () => [1, 2, 3],
    publish: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(8);
      active -= 1;
    },
    describe: (n) => String(n),
    log: () => undefined,
  });
  await sleep(60);
  stop();
  assert.equal(maxActive, 1);
});
