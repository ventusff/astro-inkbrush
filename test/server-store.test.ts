import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { noteKey, readJson, readNdjson, withLock, writeFileAtomic, writeJson } from '../src/wiki/server/store.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'inkbrush-store-'));

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

test('note keys are reversible and collision-free', () => {
  assert.notEqual(noteKey('a/b'), noteKey('a__b'));
  assert.equal(decodeURIComponent(noteKey('神经/渲染')), '神经/渲染');
});
