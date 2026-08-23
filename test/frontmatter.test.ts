/**
 * splitFrontmatter: the shared acceptance rules (BOM, leading blank lines,
 * LF/CRLF, fences on their own lines), the blanked line/offset-preserving
 * body, the parsed mapping and the positioned error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitFrontmatter } from '../src/lib/frontmatter.ts';

test('a plain block yields raw text, data and a blanked body', () => {
  const source = '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n';
  const fm = splitFrontmatter(source);
  assert.equal(fm.present, true);
  assert.equal(fm.raw, 'title: Hello\ntags: [a, b]');
  assert.deepEqual(fm.data, { title: 'Hello', tags: ['a', 'b'] });
  assert.equal(fm.error, null);
  assert.equal(fm.contentLine, 2);
  // the block is blanked character-for-character: same length, same lines
  assert.equal(fm.body.length, source.length);
  assert.equal(fm.body.split('\n').length, source.split('\n').length);
  assert.equal(fm.body.slice(fm.end), source.slice(fm.end));
  assert.match(fm.body, /\n\n# Body\n$/);
  assert.equal(fm.body.slice(fm.start, fm.end).trim(), '');
});

test('the block offsets cover both fences but not the following newline', () => {
  const source = '---\na: 1\n---\nbody';
  const fm = splitFrontmatter(source);
  assert.equal(fm.start, 0);
  assert.equal(source.slice(fm.start, fm.end), '---\na: 1\n---');
});

test('an optional BOM and leading blank lines are accepted and blanked', () => {
  for (const prefix of ['﻿', '\n\n', '  \n\t\n', '﻿ \n']) {
    const fm = splitFrontmatter(`${prefix}---\ntitle: T\n---\nbody`);
    assert.equal(fm.data['title'], 'T', JSON.stringify(prefix));
    assert.equal(fm.body.slice(0, fm.end).trim(), '');
  }
});

test('CRLF sources parse identically and keep their line breaks in the body', () => {
  const fm = splitFrontmatter('---\r\ntitle: Same\r\naliases:\r\n  - a\r\n---\r\nbody\r\n');
  assert.deepEqual(fm.data, { title: 'Same', aliases: ['a'] });
  assert.equal(fm.contentLine, 2);
  assert.match(fm.body, /^ *\r\n/);
  assert.match(fm.body, /body\r\n$/);
});

test('YAML handles quoting, multiline scalars and lists (real YAML, not line splitting)', () => {
  const fm = splitFrontmatter(
    ['---', 'title: "A: b, #c"', 'note: >-', '  folded', '  text', 'tags:', '  - x', "  - 'y: z'", '---', ''].join('\n'),
  );
  assert.deepEqual(fm.data, { title: 'A: b, #c', note: 'folded text', tags: ['x', 'y: z'] });
});

test('an empty block is present with empty raw and data', () => {
  const fm = splitFrontmatter('---\n---\nbody');
  assert.equal(fm.present, true);
  assert.equal(fm.raw, '');
  assert.deepEqual(fm.data, {});
  assert.equal(fm.error, null);
});

test('no block: no fences, an unclosed fence, or a close fence not on its own line', () => {
  for (const source of ['plain text', '---\ntitle: x\nno close', '---\ntitle: x\n---tail\nmore', 'x\n---\ny\n---\n']) {
    const fm = splitFrontmatter(source);
    assert.equal(fm.present, false, JSON.stringify(source));
    assert.equal(fm.body, source);
    assert.deepEqual(fm.data, {});
    assert.equal(fm.error, null);
  }
});

test('fences tolerate trailing spaces; a language tag on the fence does not open a block', () => {
  assert.equal(splitFrontmatter('---  \ntitle: x\n---\t\nbody').data['title'], 'x');
  assert.equal(splitFrontmatter('---yaml\ntitle: x\n---\n').present, false);
});

test('broken YAML yields empty data and an error positioned in file lines', () => {
  const fm = splitFrontmatter('\n\n---\nok: 1\ntitle: [unclosed\n---\nbody');
  assert.deepEqual(fm.data, {});
  assert.ok(fm.error);
  assert.equal(typeof fm.error.message, 'string');
  assert.doesNotMatch(fm.error.message, / at line \d+/);
  // the flow sequence opens on file line 5 (two blank lines + fence + ok)
  assert.equal(fm.error.line, 5);
  assert.ok((fm.error.column ?? 0) >= 1);
  // the body still blanks the block so the rest compiles line-true
  assert.equal(fm.body.split('\n').length, 7);
});

test('a non-mapping document is empty data with an explanatory error', () => {
  for (const source of ['---\n- a\n- b\n---\n', '---\njust a scalar\n---\n']) {
    const fm = splitFrontmatter(source);
    assert.deepEqual(fm.data, {});
    assert.match(fm.error?.message ?? '', /not a YAML mapping/);
  }
});

test('a null-ish document (comments only) is empty data without an error', () => {
  const fm = splitFrontmatter('---\n# only a comment\n---\nbody');
  assert.deepEqual(fm.data, {});
  assert.equal(fm.error, null);
});

test('a YAML document separator inside the block closes it, as the site build would', () => {
  const fm = splitFrontmatter('---\ntitle: x\n---\nsecond: doc\n---\nbody');
  assert.deepEqual(fm.data, { title: 'x' });
  assert.match(fm.body.slice(fm.end), /^\nsecond: doc/);
});
