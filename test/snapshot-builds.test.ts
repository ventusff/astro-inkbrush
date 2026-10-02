/**
 * The cached snapshot builds: every build runs into a directory of its own
 * and becomes current in one atomic step, so a reader never sees a partial
 * or mixed build — not while this process builds, and not while another
 * process serving the same `.wiki/` builds at the same time.
 *
 * The project's astro binary is a stand-in that behaves like `astro build`
 * where it matters here: it empties its --outDir, then writes the page and,
 * a moment later, a second file carrying the same token.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { buildSnapshot, snapshotCache } from '../src/wiki/server/snapshot.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FAKE_ASTRO = `#!${process.execPath}
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
const token = process.pid + '-' + Math.random().toString(36).slice(2);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), '<!doctype html><p>' + token + '</p>');
setTimeout(() => {
  if (existsSync('fail')) process.exit(1);
  writeFileSync(join(outDir, 'token.txt'), token);
}, 150);
`;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** a project with the stand-in astro, a build input last changed 10 s ago
 *  and a current build that predates it */
function project(): { root: string; previous: string } {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-builds-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const astro = join(root, 'node_modules', '.bin', 'astro');
  writeFileSync(astro, FAKE_ASTRO);
  chmodSync(astro, 0o755);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.md'), '# a\n');
  const then = (Date.now() - 10_000) / 1000;
  utimesSync(join(root, 'src', 'a.md'), then, then);
  utimesSync(join(root, 'src'), then, then);
  const startedAt = Date.now() - 20_000;
  const name = `${startedAt}-0000abcd`;
  const previous = join(root, '.wiki', 'share-dist', name);
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, 'index.html'), '<!doctype html><p>previous</p>');
  writeFileSync(join(previous, 'token.txt'), 'previous');
  writeFileSync(join(root, '.wiki', 'share-dist.stamp'), JSON.stringify({ name, startedAt }));
  return { root, previous };
}

const builds = (root: string): string[] => readdirSync(join(root, '.wiki', 'share-dist')).sort();
const current = (root: string): string => JSON.parse(readFileSync(join(root, '.wiki', 'share-dist.stamp'), 'utf8')).name;

/** a complete build: its page and its second file carry one token */
function assertWhole(dir: string): string {
  const token = readFileSync(join(dir, 'token.txt'), 'utf8');
  assert.ok(readFileSync(join(dir, 'index.html'), 'utf8').includes(`<p>${token}</p>`), `${dir} mixes two builds`);
  return token;
}

async function snapshotOf(root: string, build: typeof buildSnapshot = buildSnapshot): Promise<string> {
  const snapshot = await build(root, '/');
  try {
    return readFileSync(join(snapshot.dir, 'index.html'), 'utf8');
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

test('a build becomes current only once complete; until then readers get the previous one', async () => {
  const { root, previous } = project();
  // stale: the input changed after the current build started
  assert.equal(snapshotCache(root).fresh, false);
  const pending = snapshotOf(root);
  await sleep(60);
  // mid-build: the stamp still names the previous build, untouched
  assert.equal(join(root, '.wiki', 'share-dist', current(root)), previous);
  assert.equal(assertWhole(previous), 'previous');
  assert.ok(builds(root).some((entry) => entry.endsWith('.partial')));
  const html = await pending;
  const dir = snapshotCache(root).dir!;
  assert.ok(dir, 'the new build is current and fresh');
  const token = assertWhole(dir);
  assert.ok(html.includes(token), 'the snapshot was cut from the new build');
  // the replaced build stays for a share still copying from it; no partial is left
  assert.deepEqual(builds(root), [current(root), previous.split('/').pop()!].sort());
  // fresh now: the next share reuses it
  assert.ok((await snapshotOf(root)).includes(token));
});

test('two processes building at once each publish a whole build', async () => {
  const { root } = project();
  // two module instances: two processes' in-process build queues
  const instance = async (name: string): Promise<typeof import('../src/wiki/server/snapshot.ts')> =>
    import(`${new URL('../src/wiki/server/snapshot.ts', import.meta.url).href}?process=${name}`);
  const [a, b] = await Promise.all([instance('a'), instance('b')]);
  const [htmlA, htmlB] = await Promise.all([snapshotOf(root, a.buildSnapshot), snapshotOf(root, b.buildSnapshot)]);
  const tokens = builds(root)
    .filter((entry) => !entry.endsWith('.partial'))
    .map((entry) => assertWhole(join(root, '.wiki', 'share-dist', entry)));
  assert.ok(tokens.some((token) => htmlA.includes(token)), 'process a cut its snapshot from a whole build');
  assert.ok(tokens.some((token) => htmlB.includes(token)), 'process b cut its snapshot from a whole build');
  assert.notEqual(htmlA, htmlB, 'each process built its own');
  assertWhole(snapshotCache(root).dir!);
});

test('a failed build leaves the current build as it was and no partial behind', async () => {
  const { root, previous } = project();
  writeFileSync(join(root, 'fail'), '');
  await assert.rejects(snapshotOf(root), /astro build failed/);
  assert.equal(join(root, '.wiki', 'share-dist', current(root)), previous);
  assert.equal(assertWhole(previous), 'previous');
  assert.deepEqual(builds(root), [previous.split('/').pop()!]);
});

test('publishing prunes superseded, abandoned and foreign entries; young builds stay', async () => {
  const { root, previous } = project();
  const dist = join(root, '.wiki', 'share-dist');
  const hour = 60 * 60_000;
  const superseded = `${Date.now() - 3 * hour}-0000beef`;
  const abandoned = `${Date.now() - 2 * hour}-0000cafe.partial`;
  const running = `${Date.now() - 60_000}-0000f00d.partial`;
  const young = `${Date.now() - 60_000}-0000d00d`;
  for (const entry of [superseded, abandoned, running, young]) mkdirSync(join(dist, entry));
  // a build output laid directly into the directory belongs to no build
  mkdirSync(join(dist, '_astro'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  await snapshotOf(root);
  const name = current(root);
  assert.deepEqual(builds(root), [name, previous.split('/').pop()!, running, young].sort());
  assert.ok(!existsSync(join(dist, superseded)) && !existsSync(join(dist, abandoned)));
});
