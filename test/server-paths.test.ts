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

test('a directory symlink is followed: outside the root refused, inside resolved', () => {
  // the shape of a symlinked content.dir — the source layer refuses a
  // content root whose real path escapes the project through this check
  const base = mkdtempSync(join(tmpdir(), 'inkbrush-paths-'));
  const project = join(base, 'project');
  mkdirSync(join(project, 'real-content'), { recursive: true });
  mkdirSync(join(base, 'elsewhere'));
  symlinkSync(join(base, 'elsewhere'), join(project, 'escaping-content'));
  symlinkSync(join(project, 'real-content'), join(project, 'content'));

  assert.equal(containedPath(project, 'escaping-content'), null);
  assert.equal(containedPath(project, 'content'), realpathDeep(join(project, 'real-content')));
  rmSync(base, { recursive: true });
});
