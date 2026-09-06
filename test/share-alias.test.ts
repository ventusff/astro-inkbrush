/**
 * The readable address of a public share: the shape the gateway accepts,
 * and the default derived from a note id.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALIAS_MAX, aliasFor, validAlias } from '../src/wiki/shared/share-alias.ts';

test('a note id becomes an alias: lowercased, other characters collapsed to one hyphen', () => {
  assert.equal(aliasFor('chasing/attention'), 'chasing-attention');
  assert.equal(aliasFor('en/3dgs-cuda'), 'en-3dgs-cuda');
  assert.equal(aliasFor('Fable_Astra  Benchmarks!'), 'fable-astra-benchmarks');
  assert.equal(aliasFor('/leading/and/trailing/'), 'leading-and-trailing');
  assert.equal(aliasFor('中文'), '');
  assert.equal(aliasFor('---'), '');
});

test('a long id is cut to the maximum without ending in a hyphen', () => {
  const long = `${'a'.repeat(ALIAS_MAX - 1)}-bbbb`;
  const alias = aliasFor(long);
  assert.equal(alias.length, ALIAS_MAX - 1);
  assert.equal(alias, 'a'.repeat(ALIAS_MAX - 1));
  assert.ok(validAlias(alias));
  assert.ok(validAlias(aliasFor('x'.repeat(200))));
});

test('the alias shape: lowercase letters, digits, inner hyphens, 1–64 characters', () => {
  for (const ok of ['a', 'a1', 'my-note', 'a'.repeat(ALIAS_MAX), '2026-notes']) assert.ok(validAlias(ok), ok);
  for (const bad of ['', '-a', 'a-', 'A', 'a b', 'a.b', 'a/b', 'a'.repeat(ALIAS_MAX + 1), 'ü']) {
    assert.equal(validAlias(bad), false, bad);
  }
});
