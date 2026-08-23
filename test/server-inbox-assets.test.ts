import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assetsBasenameCandidates, vaultPathCandidates } from '../src/wiki/server/paths.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'inkbrush-inbox-'));

test('a vault-absolute embed path resolves to a suffix inside the watch dir', () => {
  const vault = scratch();
  const watchDir = join(vault, 'Inbox', 'clips');
  mkdirSync(join(watchDir, 'images'), { recursive: true });
  writeFileSync(join(watchDir, 'images', 'x.jpg'), 'jpg');

  const candidates = vaultPathCandidates(watchDir, 'Inbox/clips/images/x.jpg');
  assert.ok(candidates.includes(join(watchDir, 'images', 'x.jpg')));
  rmSync(vault, { recursive: true });
});

test('bare basenames and a null watch dir produce no candidates', () => {
  assert.deepEqual(vaultPathCandidates('/anywhere', 'x.jpg'), []);
  assert.deepEqual(vaultPathCandidates(null, 'a/b/x.jpg'), []);
});

test('suffixes that would escape the watch dir are refused', () => {
  const vault = scratch();
  const watchDir = join(vault, 'clips');
  mkdirSync(watchDir, { recursive: true });
  for (const candidate of vaultPathCandidates(watchDir, 'a/../../etc/passwd')) {
    assert.ok(candidate.startsWith(watchDir));
  }
  rmSync(vault, { recursive: true });
});

test('a basename resolves under any _assets subfolder even when its name diverged', () => {
  const vault = scratch();
  const assetsDir = join(vault, '2026-05-26', '_assets');
  mkdirSync(join(assetsDir, 'title without trailing dots'), { recursive: true });
  writeFileSync(join(assetsDir, 'title without trailing dots', 'abc_MD5.jpg'), 'jpg');

  const bare = assetsBasenameCandidates(assetsDir, 'abc_MD5.jpg');
  const pathed = assetsBasenameCandidates(assetsDir, 'Inbox/clips/images/abc_MD5.jpg');
  for (const got of [bare, pathed]) {
    assert.ok(got.includes(join(assetsDir, 'title without trailing dots', 'abc_MD5.jpg')));
  }
  assert.deepEqual(assetsBasenameCandidates(join(vault, 'nope'), 'abc.jpg'), []);
  rmSync(vault, { recursive: true });
});
