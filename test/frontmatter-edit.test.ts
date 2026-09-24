import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitFrontmatter } from '../src/lib/frontmatter.ts';
import { setFrontmatterFields } from '../src/lib/frontmatter-edit.ts';

const note = `---
title: "Hello: world"
# how the note is classified
kind: essay
domains: [infra, llm]
tags:
- x
- y
description: |
  para one

  para two
nested:
  a: 1
  b:
    - q
---

# Body

text with **bold** and [[link]]
`;

test('a replaced key keeps every other byte, comments included', () => {
  const out = setFrontmatterFields(note, { kind: 'note', domains: ['robotics'] });
  assert.equal(
    out,
    note.replace('kind: essay', 'kind: note').replace('domains: [infra, llm]', 'domains: [robotics]'),
  );
  assert.deepEqual(splitFrontmatter(out).data['domains'], ['robotics']);
});

test('a deleted key loses its lines and nothing else; a comment above the next key survives', () => {
  const out = setFrontmatterFields(note, { title: undefined, tags: undefined, description: undefined });
  assert.equal(
    out,
    note
      .replace('title: "Hello: world"\n', '')
      .replace('tags:\n- x\n- y\n', '')
      .replace('description: |\n  para one\n\n  para two\n', ''),
  );
  assert.ok(out.includes('# how the note is classified\nkind: essay'));
});

test('a missing key is appended before the closing fence; `last` keys go last in order', () => {
  const out = setFrontmatterFields(
    note,
    { status: 'draft', origin: { wiki: 'vortex', revision: '3f9c2a1b7d4e5f60', synced: '2026-09-23T10:21:07Z' } },
    { last: ['origin'] },
  );
  assert.ok(out.endsWith('    - q\nstatus: draft\norigin:\n  wiki: vortex\n  revision: 3f9c2a1b7d4e5f60\n  synced: 2026-09-23T10:21:07Z\n---\n\n# Body\n\ntext with **bold** and [[link]]\n'));
  // re-stamping moves the key to the end and replaces its value
  const again = setFrontmatterFields(
    setFrontmatterFields(out, { author: 'x' }),
    { origin: { wiki: 'vortex', revision: 'ffffffffffffffff', synced: '2026-09-24T00:00:00Z' } },
    { last: ['origin'] },
  );
  assert.ok(again.includes('author: x\norigin:\n  wiki: vortex\n  revision: ffffffffffffffff\n  synced: 2026-09-24T00:00:00Z\n---'));
  assert.equal(again.match(/^origin:/gm)?.length, 1);
});

test('values render in house style: block maps, flow lists of scalars, quoting where YAML needs it', () => {
  const out = setFrontmatterFields('---\ntitle: t\n---\nbody\n', {
    domains: ['a', 'b'],
    empty: [],
    colon: 'a: b',
    nothing: null,
    map: { k: ['x'], n: 2 },
  });
  assert.equal(
    out,
    '---\ntitle: t\ndomains: [a, b]\nempty: []\ncolon: "a: b"\nnothing: null\nmap:\n  k: [x]\n  n: 2\n---\nbody\n',
  );
  assert.deepEqual(splitFrontmatter(out).data, {
    title: 't',
    domains: ['a', 'b'],
    empty: [],
    colon: 'a: b',
    nothing: null,
    map: { k: ['x'], n: 2 },
  });
});

test('CRLF sources keep CRLF; an empty block gains its first key cleanly', () => {
  const crlf = '---\r\ntitle: t\r\nkind: a\r\n---\r\n\r\nbody\r\n';
  assert.equal(setFrontmatterFields(crlf, { kind: 'b', status: 'x' }), '---\r\ntitle: t\r\nkind: b\r\nstatus: x\r\n---\r\n\r\nbody\r\n');
  assert.equal(setFrontmatterFields('---\n---\nbody\n', { title: 'new' }), '---\ntitle: new\n---\nbody\n');
  // deleting the only key leaves an empty block
  assert.equal(setFrontmatterFields('---\ntitle: t\n---\nbody\n', { title: undefined }), '---\n---\nbody\n');
});

test('quoted keys and keys followed by column-0 sequences are found; leading blank lines are kept', () => {
  const src = '\n\n---\n"quoted key": 1\nlist:\n- a\n# note\n- b\nother: 2\n---\nbody';
  const out = setFrontmatterFields(src, { 'quoted key': 2, list: undefined });
  assert.equal(out, '\n\n---\nquoted key: 2\nother: 2\n---\nbody');
});

test('a source without a block, or with a broken block, is refused', () => {
  assert.throws(() => setFrontmatterFields('no block\n', { a: 1 }), /no frontmatter block/);
  assert.throws(() => setFrontmatterFields('---\nbad: [\n---\nbody\n', { a: 1 }), /does not parse/);
});

test('spans come from the YAML syntax tree: inline maps, indented top-level mappings, multi-line flow lists', () => {
  assert.equal(setFrontmatterFields('---\ntitle: Hello\ntags: [a, b]\n---\n', { title: 'Bye' }), '---\ntitle: Bye\ntags: [a, b]\n---\n');
  assert.equal(setFrontmatterFields('---\n  title: Hello\n  tags: [a, b]\n---\n', { title: 'Bye' }), '---\n  title: Bye\n  tags: [a, b]\n---\n');
  assert.equal(setFrontmatterFields('---\ntags: [\n  a,\n  b\n]\nkind: x\n---\n', { tags: ['c'] }), '---\ntags: [c]\nkind: x\n---\n');
  assert.equal(setFrontmatterFields('---\nempty:\nnext: 1\n---\n', { empty: 'v' }), '---\nempty: v\nnext: 1\n---\n');
  assert.equal(setFrontmatterFields('---\na: 1 # note\nb: 2\n---\n', { a: 3 }), '---\na: 3\nb: 2\n---\n');
});

test('an edit that would leave another key without its value is refused, and so is a non-mapping block', () => {
  assert.throws(() => setFrontmatterFields('---\ntags: &t [a, b]\naliases: *t\n---\n', { tags: ['c'] }), /alias/);
  assert.throws(() => setFrontmatterFields('---\n{a: 1}\n---\n', { a: 2 }), /mapping/);
  assert.throws(() => setFrontmatterFields('---\n- a\n- b\n---\n', { a: 2 }), /mapping/);
});

test('`last` keys keep the given order', () => {
  assert.equal(setFrontmatterFields('---\na: 1\nb: 2\nc: 3\n---\n', { a: 1, b: 2 }, { last: ['b', 'a'] }), '---\nc: 3\nb: 2\na: 1\n---\n');
});

test('explicit and complex keys are not editable; a requested field must land exactly', () => {
  assert.throws(() => setFrontmatterFields('---\n? title\n: Hello\ntags: [a, b]\n---\n', { title: 'Bye' }), /explicit/);
  assert.throws(() => setFrontmatterFields('---\n? [a, b]\n: c\ntitle: t\n---\n', { '[ a, b ]': 'x' }), /explicit|complex/);
  // other keys beside an explicit one stay editable, and the explicit key keeps its value
  assert.equal(setFrontmatterFields('---\n? title\n: Hello\ntags: [a, b]\n---\n', { tags: ['c'] }), '---\n? title\n: Hello\ntags: [c]\n---\n');
  assert.equal(splitFrontmatter(setFrontmatterFields('---\n? title\n: Hello\ntags: [a, b]\n---\n', { tags: ['c'] })).data['title'], 'Hello');
});
