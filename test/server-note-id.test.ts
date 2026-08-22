import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frontmatterField, NOTE_ID } from '../src/wiki/server/note-id.ts';

test('note ids accept Unicode letters and numbers across scripts', () => {
  for (const id of [
    'guides/getting-started',
    'en/getting-started',
    '神经/渲染',
    'русский/тест',
    'café-notes',
    'ノート2024',
    'a_b.c-d',
  ]) {
    assert.ok(NOTE_ID.test(id), `should accept '${id}'`);
  }
});

test('note ids refuse empty, dotted, traversal and separator shapes', () => {
  for (const id of ['', '.', '..', '../x', 'a//b', '/abs', 'a/', '.hidden', 'a/.b', '-flag', 'a b', 'a\\b']) {
    assert.ok(!NOTE_ID.test(id), `should refuse '${id}'`);
  }
});

test('frontmatterField parses real YAML and falls back to null on errors', () => {
  const doc = '---\ntitle: "Hello: world"\ncount: 3\nnested:\n  x: 1\n---\n\nbody';
  assert.equal(frontmatterField(doc, 'title'), 'Hello: world');
  assert.equal(frontmatterField(doc, 'count'), '3');
  assert.equal(frontmatterField(doc, 'nested'), null); // not scalar
  assert.equal(frontmatterField(doc, 'missing'), null);
  assert.equal(frontmatterField('no frontmatter', 'title'), null);
  assert.equal(frontmatterField('---\ntitle: [broken\n---\n', 'title'), null);
});
