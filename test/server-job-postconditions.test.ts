import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockEditViolation, revisionSpan, translateViolation } from '../src/wiki/server/job-postconditions.ts';

const NOTE = 'notes/a/index.md';

test('a block edit that stays inside the selected span passes', () => {
  const baseline = 'one\ntwo\nthree\nfour\nfive';
  for (const block of ['TWO\nTHREE', 'TWO', 'TWO\nextra\nlines\nTHREE', '']) {
    const changed = ['one', ...(block ? block.split('\n') : []), 'four', 'five'].join('\n');
    assert.equal(
      blockEditViolation({
        noteRel: NOTE,
        baseline,
        changes: [{ rel: NOTE, content: changed }],
        start: 2,
        end: 3,
      }),
      null,
      `block replacement '${block}' should pass`,
    );
  }
});

test('a block edit that touches lines outside the span is refused', () => {
  const baseline = 'one\ntwo\nthree\nfour';
  const cases = [
    'ONE\ntwo\nthree\nfour', // before the span
    'one\ntwo\nthree\nFOUR', // after the span
    'one\ntwo', // suffix dropped
    'four', // shorter than the outside lines
  ];
  for (const changed of cases) {
    assert.match(
      blockEditViolation({
        noteRel: NOTE,
        baseline,
        changes: [{ rel: NOTE, content: changed }],
        start: 2,
        end: 3,
      }) ?? '',
      /outside the selected block/,
      `'${changed.replace(/\n/g, '⏎')}' should be refused`,
    );
  }
});

test('a block edit may change companions only, and never delete the note', () => {
  const baseline = 'one\ntwo';
  assert.equal(
    blockEditViolation({
      noteRel: NOTE,
      baseline,
      changes: [{ rel: 'src/demos/a.ts', content: 'export const x = 1;' }],
      start: 1,
      end: 2,
    }),
    null,
  );
  assert.match(
    blockEditViolation({
      noteRel: NOTE,
      baseline,
      changes: [{ rel: NOTE, content: null }],
      start: 1,
      end: 2,
    }) ?? '',
    /deleted/,
  );
});

test('a translation must not touch the source and must produce the target', () => {
  const sourceRel = 'notes/a/index.md';
  const targetRel = 'notes/en/a/index.md';
  assert.equal(
    translateViolation({
      sourceRel,
      targetRel,
      changes: [{ rel: targetRel, content: '---\ntitle: A\n---\n' }],
    }),
    null,
  );
  assert.match(
    translateViolation({
      sourceRel,
      targetRel,
      changes: [
        { rel: sourceRel, content: 'rewritten source' },
        { rel: targetRel, content: 'x' },
      ],
    }) ?? '',
    /modified the source note/,
  );
  assert.match(
    translateViolation({ sourceRel, targetRel, changes: [{ rel: sourceRel, content: null }] }) ?? '',
    /modified the source note/,
  );
  assert.match(
    translateViolation({ sourceRel, targetRel, changes: [{ rel: 'notes/en/a/other.md', content: 'x' }] }) ?? '',
    /did not produce the target file/,
  );
  assert.match(
    translateViolation({ sourceRel, targetRel, changes: [{ rel: targetRel, content: null }] }) ?? '',
    /did not produce the target file/,
  );
});

test('revisionSpan trims the common prefix/suffix into a revertible line span', () => {
  const span = revisionSpan('a\nb\nc\nd', 'a\nB\nB2\nc\nd');
  assert.deepEqual(span, { lines: '2-3', before: 'b', after: 'B\nB2' });
  assert.equal(revisionSpan('same', 'same'), null);
});

test('a change with no baseline and a whole-file change journal as lines *', () => {
  // a file that did not exist journals its full content as an audit row
  const created = revisionSpan('', '---\ntitle: T\n---\nbody');
  assert.equal(created?.lines, '*');
  assert.equal(created?.before, '');
  assert.equal(created?.after, '---\ntitle: T\n---\nbody');
  // a rewrite sharing no first and no last line is whole-file scale
  const rewritten = revisionSpan('old one\nold two', 'new one\nnew two');
  assert.equal(rewritten?.lines, '*');
  assert.equal(rewritten?.before, 'old one\nold two');
  assert.equal(rewritten?.after, 'new one\nnew two');
});
