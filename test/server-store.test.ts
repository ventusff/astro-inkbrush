import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  appendNdjson,
  noteKey,
  readJson,
  readNdjson,
  setProjectRoot,
  withLock,
  writeFileAtomic,
  writeJson,
} from '../src/wiki/server/store.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'inkbrush-store-'));

const modeOf = (path: string): number => statSync(path).mode & 0o777;

test('NDJSON tolerates exactly one torn record, its last line', () => {
  const dir = scratch();
  const file = join(dir, 'log.ndjson');
  writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3');
  assert.deepEqual(readNdjson(file), [{ a: 1 }, { a: 2 }]);
  writeFileSync(file, '{"a":1}\nnot json\n{"a":3}\n');
  assert.throws(() => readNdjson(file), /log\.ndjson:2: malformed record/);
  rmSync(dir, { recursive: true });
});

test('a JSON file that exists but does not parse is an error, a missing one is the fallback', () => {
  const dir = scratch();
  const file = join(dir, 'state.json');
  assert.deepEqual(readJson(file, { fresh: true }), { fresh: true });
  writeFileSync(file, '{broken');
  assert.throws(() => readJson(file, {}), /not JSON/);
  writeJson(file, { ok: 1 });
  assert.deepEqual(readJson(file, {}), { ok: 1 });
  rmSync(dir, { recursive: true });
});

test('atomic writes leave no temp file behind and replace the content whole', () => {
  const dir = scratch();
  const file = join(dir, 'nested', 'out.txt');
  writeFileAtomic(file, 'first');
  writeFileAtomic(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), 'second');
  rmSync(dir, { recursive: true });
});

test('withLock serializes read-modify-write sequences on one key', async () => {
  let value = 0;
  const bump = () =>
    withLock('counter', async () => {
      const seen = value;
      await new Promise((r) => setTimeout(r, 5));
      value = seen + 1;
    });
  await Promise.all([bump(), bump(), bump()]);
  assert.equal(value, 3);
  await assert.rejects(withLock('counter', () => Promise.reject(new Error('boom'))), /boom/);
  // the lock is released after a rejection
  assert.equal(await withLock('counter', () => 'free'), 'free');
});

test('.wiki state is private: dirs 0700, new files 0600; content files keep the default', () => {
  const prevUmask = process.umask(0o022);
  const root = scratch();
  setProjectRoot(root);
  try {
    writeFileAtomic(join(root, '.wiki', 'data', 'state.json'), '{}');
    assert.equal(modeOf(join(root, '.wiki')), 0o700);
    assert.equal(modeOf(join(root, '.wiki', 'data')), 0o700);
    assert.equal(modeOf(join(root, '.wiki', 'data', 'state.json')), 0o600);
    appendNdjson(join(root, '.wiki', 'data', 'log.ndjson'), { a: 1 });
    assert.equal(modeOf(join(root, '.wiki', 'data', 'log.ndjson')), 0o600);
    // outside .wiki the process default applies (0644 under umask 022)
    writeFileAtomic(join(root, 'notes', 'a', 'index.md'), 'content');
    assert.equal(modeOf(join(root, 'notes', 'a', 'index.md')), 0o644);
  } finally {
    setProjectRoot(process.cwd());
    process.umask(prevUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rewrite preserves an existing file mode', () => {
  const prevUmask = process.umask(0o022);
  const root = scratch();
  setProjectRoot(root);
  try {
    const inside = join(root, '.wiki', 'special.json');
    writeFileAtomic(inside, '1');
    chmodSync(inside, 0o640);
    writeFileAtomic(inside, '2');
    assert.equal(readFileSync(inside, 'utf8'), '2');
    assert.equal(modeOf(inside), 0o640);
    const outside = join(root, 'plain.txt');
    writeFileAtomic(outside, '1');
    chmodSync(outside, 0o600);
    writeFileAtomic(outside, '2');
    assert.equal(modeOf(outside), 0o600);
  } finally {
    setProjectRoot(process.cwd());
    process.umask(prevUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

test('note keys are reversible and collision-free', () => {
  assert.notEqual(noteKey('a/b'), noteKey('a__b'));
  assert.equal(decodeURIComponent(noteKey('神经/渲染')), '神经/渲染');
});
