/**
 * The snapshot cache predicate and the background warmer that keeps it
 * fresh: stale + quiet → one build; stale but still changing → wait;
 * fresh → nothing; off duty → nothing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { snapshotCache, startSnapshotWarmer } from '../src/wiki/server/snapshot.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const STAMP = ['.wiki', 'share-dist.stamp'];

/** a project whose only build input is src/a.md, last changed `ageMs` ago,
 *  with a current build started now */
function project(ageMs: number): { root: string; build: string } {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-warmer-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.md'), '# a\n');
  const then = (Date.now() - ageMs) / 1000;
  utimesSync(join(root, 'src', 'a.md'), then, then);
  utimesSync(join(root, 'src'), then, then);
  const startedAt = Date.now();
  const name = `${startedAt}-0000abcd`;
  const build = join(root, '.wiki', 'share-dist', name);
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, ...STAMP), JSON.stringify({ name, startedAt }));
  return { root, build };
}


test('a build started after every input is fresh; a newer input makes it stale', () => {
  const { root, build } = project(120_000);
  assert.deepEqual(snapshotCache(root).dir, build);
  assert.equal(snapshotCache(root).fresh, true);
  writeFileSync(join(root, 'src', 'a.md'), '# a2\n');
  // the rewrite must postdate the stamp by more than a clock tick — a write
  // landing in the stamp's own millisecond is not "newer"
  const later = Date.now() / 1000 + 1;
  utimesSync(join(root, 'src', 'a.md'), later, later);
  const { fresh, dir, latestInput } = snapshotCache(root);
  assert.equal(fresh, false);
  assert.equal(dir, null);
  assert.ok(Date.now() - latestInput < 5000, 'latestInput dates the change');
});

test('a missing cached build is stale regardless of the stamp', () => {
  const { root, build } = project(120_000);
  rmSync(join(build, 'index.html'));
  assert.equal(snapshotCache(root).fresh, false);
});

test('a stamp that names no complete build is no cache', () => {
  const { root, build } = project(120_000);
  const name = build.split(/[\\/]/).pop()!;
  for (const stamp of [String(Date.now()), '{', JSON.stringify({ name: `${name}.partial`, startedAt: Date.now() }), JSON.stringify({ name: '../x', startedAt: Date.now() })]) {
    writeFileSync(join(root, ...STAMP), stamp);
    assert.equal(snapshotCache(root).fresh, false, stamp);
  }
});

test('the warmer leaves a fresh cache alone', async () => {
  const { root } = project(120_000);
  const logs: string[] = [];
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => logs.push(m) });
  await sleep(60);
  stop();
  assert.deepEqual(logs, []);
});

test('the warmer waits while the inputs are still changing', async () => {
  const { root } = project(120_000);
  writeFileSync(join(root, 'src', 'a.md'), '# edited just now\n');
  const logs: string[] = [];
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 60_000, log: (m) => logs.push(m) });
  await sleep(60);
  stop();
  assert.deepEqual(logs, []);
});

test('stale and quiet: the warmer runs one build and reports its outcome', async () => {
  const { root } = project(120_000);
  rmSync(join(root, ...STAMP));
  const logs: string[] = [];
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => logs.push(m) });
  await sleep(200);
  stop();
  // no astro binary in a bare temp project: the build attempt fails and says so
  assert.ok(logs[0]?.includes('refreshing the snapshot build'), logs.join(' | '));
  assert.ok(logs.some((m) => m.includes('astro binary not found')), logs.join(' | '));
  // one attempt for one state of the inputs — a failure is not retried
  // until the inputs change again
  assert.equal(logs.filter((m) => m.includes('refreshing')).length, 1);
  assert.equal(logs.filter((m) => m.includes('failed')).length, 1);
});

test('after a failure the next attempt waits for the inputs to change', async () => {
  const { root } = project(120_000);
  rmSync(join(root, ...STAMP));
  const logs: string[] = [];
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => logs.push(m) });
  await sleep(120);
  assert.equal(logs.filter((m) => m.includes('refreshing')).length, 1);
  writeFileSync(join(root, 'src', 'a.md'), '# changed again\n');
  await sleep(120);
  stop();
  assert.equal(logs.filter((m) => m.includes('refreshing')).length, 2);
});

test('starting a warmer replaces the running one', async () => {
  const { root } = project(120_000);
  const first: string[] = [];
  startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => first.push(m) });
  const second: string[] = [];
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => second.push(m) });
  rmSync(join(root, ...STAMP));
  await sleep(100);
  stop();
  assert.deepEqual(first, []);
  assert.ok(second.length > 0);
});

test('off duty the warmer builds nothing; it builds once duty comes back', async () => {
  const { root } = project(120_000);
  rmSync(join(root, ...STAMP));
  const logs: string[] = [];
  let duty = false;
  const stop = startSnapshotWarmer(root, { intervalMs: 5, idleMs: 0, log: (m) => logs.push(m), onDuty: () => duty });
  await sleep(60);
  assert.equal(logs.length, 0);
  duty = true;
  await sleep(120);
  stop();
  assert.equal(logs.filter((m) => m.includes('refreshing')).length, 1);
});
