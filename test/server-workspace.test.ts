import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setProjectRoot } from '../src/wiki/server/store.ts';
import { createWorkspace } from '../src/wiki/server/workspace.ts';

/** a scratch project root with one note and one out-of-root secret */
function scratchProject(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'inkbrush-ws-'));
  const root = join(base, 'project');
  mkdirSync(join(root, 'notes', 'a'), { recursive: true });
  writeFileSync(join(root, 'notes', 'a', 'index.md'), 'one\n');
  writeFileSync(join(base, 'outside.txt'), 'secret\n');
  setProjectRoot(root);
  return { base, root };
}

test('scope entries must be relative, ..-free, non-empty and inside the root', () => {
  const { base } = scratchProject();
  assert.throws(() => createWorkspace(['/etc']), /must be relative/);
  assert.throws(() => createWorkspace(['notes/../../evil']), /must not contain '\.\.'/);
  assert.throws(() => createWorkspace(['']), /empty/);
  assert.throws(() => createWorkspace(['  ']), /empty/);
  rmSync(base, { recursive: true, force: true });
});

test('overlapping scope entries are deduplicated', () => {
  const { base } = scratchProject();
  const ws = createWorkspace(['notes/a', 'notes']);
  assert.deepEqual(ws.scope, ['notes']);
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});

test('symlinks are not copied into the workspace and never appear as changes', () => {
  const { base, root } = scratchProject();
  symlinkSync(join(base, 'outside.txt'), join(root, 'notes', 'a', 'link'));
  const ws = createWorkspace(['notes/a']);
  assert.ok(!existsSync(join(ws.dir, 'notes', 'a', 'link')));
  assert.deepEqual(ws.changes(), []);
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});

test('apply refuses a change outside the scoped roots and writes nothing', async () => {
  const { base, root } = scratchProject();
  const ws = createWorkspace(['notes/a']);
  await assert.rejects(ws.apply([{ rel: 'secret.txt', content: 'x' }]), /outside the job's scope/);
  assert.ok(!existsSync(join(root, 'secret.txt')));
  await assert.rejects(ws.apply([{ rel: '../outside.txt', content: 'x' }]), /outside the job's scope/);
  assert.equal(readFileSync(join(base, 'outside.txt'), 'utf8'), 'secret\n');
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});

test('apply refuses to write through a symlink that escapes the scope', async () => {
  const { base, root } = scratchProject();
  symlinkSync(join(base, 'outside.txt'), join(root, 'notes', 'a', 'link'));
  const ws = createWorkspace(['notes/a']);
  await assert.rejects(ws.apply([{ rel: 'notes/a/link', content: 'evil' }]), /outside the job's scope/);
  assert.equal(readFileSync(join(base, 'outside.txt'), 'utf8'), 'secret\n');
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});

test('changes are computed against the creation baseline and a drifted file refuses the whole application', async () => {
  const { base, root } = scratchProject();
  const ws = createWorkspace(['notes/a']);
  writeFileSync(join(ws.dir, 'notes', 'a', 'index.md'), 'job result\n');
  // a concurrent edit lands in the project while the job runs
  writeFileSync(join(root, 'notes', 'a', 'index.md'), 'concurrent edit\n');
  const changes = ws.changes();
  assert.deepEqual(changes, [{ rel: 'notes/a/index.md', content: 'job result\n' }]);
  await assert.rejects(ws.apply(changes), /Conflict.*nothing was written/);
  assert.equal(readFileSync(join(root, 'notes', 'a', 'index.md'), 'utf8'), 'concurrent edit\n');
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});

test('apply writes new files, edits and deletions when the baseline holds', async () => {
  const { base, root } = scratchProject();
  writeFileSync(join(root, 'notes', 'a', 'extra.md'), 'delete me\n');
  const ws = createWorkspace(['notes/a']);
  writeFileSync(join(ws.dir, 'notes', 'a', 'index.md'), 'edited\n');
  writeFileSync(join(ws.dir, 'notes', 'a', 'new.md'), 'created\n');
  rmSync(join(ws.dir, 'notes', 'a', 'extra.md'));
  const changes = ws.changes().sort((a, b) => a.rel.localeCompare(b.rel));
  assert.deepEqual(changes, [
    { rel: 'notes/a/extra.md', content: null },
    { rel: 'notes/a/index.md', content: 'edited\n' },
    { rel: 'notes/a/new.md', content: 'created\n' },
  ]);
  assert.equal(ws.baseline('notes/a/index.md'), 'one\n');
  assert.equal(ws.baseline('notes/a/new.md'), null);
  await ws.apply(changes);
  assert.equal(readFileSync(join(root, 'notes', 'a', 'index.md'), 'utf8'), 'edited\n');
  assert.equal(readFileSync(join(root, 'notes', 'a', 'new.md'), 'utf8'), 'created\n');
  assert.ok(!existsSync(join(root, 'notes', 'a', 'extra.md')));
  ws.destroy();
  rmSync(base, { recursive: true, force: true });
});
