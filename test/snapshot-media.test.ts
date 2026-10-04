/**
 * A snapshot of a page that cites media-store addresses carries those files:
 * they are fetched from the store's origin, never from the build, and only
 * as the bytes their names say.
 *
 * The project's astro binary is a stand-in that writes the page the test
 * placed in the project as `page.html`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { buildSnapshot } from '../src/wiki/server/snapshot.ts';

const FAKE_ASTRO = `#!${process.execPath}
const { copyFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const outDir = process.argv[process.argv.indexOf('--outDir') + 1];
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'note'), { recursive: true });
copyFileSync('page.html', join(outDir, 'note', 'index.html'));
`;

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const CLIP = 'frames of a clip';
const SHOT = 'pixels of a shot';
const clip = `media/${sha256(CLIP)}.mp4`;
const shot = `media/${sha256(SHOT)}.png`;
const lost = `media/${'0'.repeat(64)}.mp4`;
const forged = `media/${'1'.repeat(64)}.png`;

const stored = new Map([[`/${clip}`, CLIP], [`/${shot}`, SHOT], [`/${forged}`, 'not what the name says']]);
let origin: Server;
let originUrl = '';
const asked: string[] = [];
before(async () => {
  origin = createServer((req, res) => {
    asked.push(req.url ?? '');
    const body = stored.get(req.url ?? '');
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

const roots: string[] = [];
after(() => {
  origin.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(page: string): string {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-media-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const astro = join(root, 'node_modules', '.bin', 'astro');
  writeFileSync(astro, FAKE_ASTRO);
  chmodSync(astro, 0o755);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.md'), '# a\n');
  writeFileSync(join(root, 'page.html'), `<!doctype html><html><head></head><body>${page}</body></html>`);
  return root;
}

test('the store files a page cites travel with its snapshot, cited relative to the page', async () => {
  const root = project(`<video src="/${clip}" controls></video><img src="/${shot}" alt=""><a href="/${clip}">download</a>`);
  const snapshot = await buildSnapshot(root, '/note/', undefined, undefined, { mediaOrigin: originUrl });
  try {
    assert.equal(readFileSync(join(snapshot.dir, clip), 'utf8'), CLIP);
    assert.equal(readFileSync(join(snapshot.dir, shot), 'utf8'), SHOT);
    assert.deepEqual(snapshot.files.filter((file) => file.startsWith('media/')).sort(), [clip, shot].sort());
    const html = readFileSync(join(snapshot.dir, 'index.html'), 'utf8');
    assert.ok(html.includes(`<video src="./${clip}"`), html);
    assert.ok(html.includes(`<img src="./${shot}"`), html);
    // one fetch per file, however often the page cites it
    assert.equal(asked.filter((url) => url === `/${clip}`).length, 1);
  } finally {
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
});

test('a cited address the store lacks fails the snapshot, naming it', async () => {
  const root = project(`<video src="/${lost}"></video>`);
  await assert.rejects(buildSnapshot(root, '/note/', undefined, undefined, { mediaOrigin: originUrl }), new RegExp(`the media store has no '/${lost}'.*answered 404`));
});

test('a file that is not the bytes its name says is refused', async () => {
  const root = project(`<img src="/${forged}" alt="">`);
  await assert.rejects(buildSnapshot(root, '/note/', undefined, undefined, { mediaOrigin: originUrl }), /is not the file its name says/);
});

test('an unreachable store fails the snapshot, naming the address', async () => {
  const root = project(`<img src="/${shot}" alt="">`);
  await assert.rejects(buildSnapshot(root, '/note/', undefined, undefined, { mediaOrigin: 'http://127.0.0.1:9' }), new RegExp(`the media store did not answer for '/${shot}'`));
});

test('without a media store an image the build lacks still fails as a missing asset', async () => {
  const root = project(`<img src="/${shot}" alt="">`);
  await assert.rejects(buildSnapshot(root, '/note/'), /requires asset .* but the build output has no such file/);
});
