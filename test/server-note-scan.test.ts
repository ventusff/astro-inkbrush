import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRootedScanner } from '../src/wiki/server/note-scan.ts';

function contentRoot(title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-scan-'));
  mkdirSync(join(root, 'note'), { recursive: true });
  writeFileSync(join(root, 'note', 'index.md'), `---\ntitle: ${title}\n---\nbody\n`);
  return root;
}

test('the scanner follows the content root it is asked about', () => {
  const rootA = contentRoot('From A');
  const rootB = contentRoot('From B');
  const scan = createRootedScanner();
  // the same scanner instance serves whichever root is current — a root
  // pinned after scanner creation must win over any earlier root
  assert.deepEqual(scan(rootA).map((n) => n.title), ['From A']);
  assert.deepEqual(scan(rootB).map((n) => n.title), ['From B']);
  assert.deepEqual(scan(rootA).map((n) => n.title), ['From A']);
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

test('within one root the short-TTL cache is reused', () => {
  const root = contentRoot('Stable');
  const scan = createRootedScanner();
  const first = scan(root);
  // within the TTL a newly added note is invisible: the second read is
  // served from the cache, not a rescan
  mkdirSync(join(root, 'later'), { recursive: true });
  writeFileSync(join(root, 'later', 'index.md'), '---\ntitle: Later\n---\n');
  assert.deepEqual(scan(root), first);
  rmSync(root, { recursive: true, force: true });
});
