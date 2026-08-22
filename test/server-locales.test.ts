import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCALES, resolveLocales } from '../src/wiki/shared/locales.ts';

const en = { code: 'en', prefix: '', label: 'English', promptName: 'English' };
const zh = { code: 'zh', prefix: 'zh/', label: '中文', promptName: '中文' };

test('absent or empty input keeps the default table', () => {
  assert.equal(resolveLocales(undefined), LOCALES);
  assert.equal(resolveLocales([]), LOCALES);
});

test('a valid custom table resolves', () => {
  const resolved = resolveLocales([en, zh]);
  assert.deepEqual(
    resolved.map((l) => l.prefix),
    ['', 'zh/'],
  );
});

test('duplicate codes and duplicate prefixes are refused', () => {
  assert.throws(() => resolveLocales([en, { ...zh, code: 'en' }]), /duplicate or empty code/);
  assert.throws(() => resolveLocales([en, { ...zh, prefix: '' }]), /duplicate prefix/);
  assert.throws(() => resolveLocales([en, zh, { ...en, code: 'de', prefix: 'zh/' }]), /duplicate prefix/);
});

test("a prefix is '' or one word-character/dash segment with a trailing slash", () => {
  assert.throws(() => resolveLocales([en, { ...zh, prefix: 'zh' }]), /must be ''/);
  assert.throws(() => resolveLocales([en, { ...zh, prefix: 'a/b/' }]), /must be ''/);
  assert.throws(() => resolveLocales([en, { ...zh, prefix: '../' }]), /must be ''/);
  assert.throws(() => resolveLocales([en, { ...zh, prefix: 'a.b/' }]), /must be ''/);
  const ok = resolveLocales([en, { ...zh, prefix: 'zh-Hans/' }]);
  assert.equal(ok[1]!.prefix, 'zh-Hans/');
});

test("exactly one locale carries the '' prefix", () => {
  assert.throws(() => resolveLocales([{ ...en, prefix: 'en/' }, zh]), /exactly one locale/);
});
