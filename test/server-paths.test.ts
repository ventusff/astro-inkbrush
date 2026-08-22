import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { containedPath, isWithin, realpathDeep } from '../src/wiki/server/paths.ts';

test('containment compares whole path components and follows symlinks', () => {
  const base = mkdtempSync(join(tmpdir(), 'inkbrush-paths-'));
  const root = join(base, 'root');
  mkdirSync(join(root, 'inside'), { recursive: true });
  mkdirSync(join(base, 'root-other'));
  writeFileSync(join(base, 'secret.txt'), 'x');
  symlinkSync(join(base, 'secret.txt'), join(root, 'inside', 'link'));

  assert.ok(isWithin(root, join(root, 'inside', 'note.md')));
  assert.ok(!isWithin(root, join(base, 'root-other', 'x')));
  assert.ok(!isWithin(root, join(root, '..', 'secret.txt')));
  // a symlink inside the root that points outside is outside
  assert.ok(!isWithin(root, join(root, 'inside', 'link')));
  assert.equal(containedPath(root, '../secret.txt'), null);
  assert.equal(containedPath(root, 'inside/new-note/index.md'), realpathDeep(join(root, 'inside/new-note/index.md')));
  rmSync(base, { recursive: true });
});
