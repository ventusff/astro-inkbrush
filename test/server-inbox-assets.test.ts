import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { vaultPathCandidates } from '../src/wiki/server/paths.ts';

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
