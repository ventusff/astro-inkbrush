/**
 * The playground overlay matches stamped nodes to segments by stamp key:
 * the page's nodes come in document order, the segments in source order,
 * and the two differ where rendering hoists content (footnotes).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOverlay, hasJsxSource, type StampedRange } from '../src/wiki/playground/overlay.ts';

const SRC = ['---', 'title: T', '---', '', 'P1.[^a]', '', '[^a]: note', '', '## H', '', 'List.'].join('\n');
const range = (start: number, end: number, extra: Partial<StampedRange> = {}): StampedRange => ({
  start,
  end,
  jsx: null,
  frontmatter: false,
  ...extra,
});
/** document order: the footnote item renders last */
const DOC_ORDER = [range(1, 3, { frontmatter: true }), range(5, 5), range(9, 9), range(11, 11), range(7, 7)];

test('segments are keyed by their original stamp and ordered by source line', () => {
  const overlay = buildOverlay(SRC, DOC_ORDER, {})!;
  assert.deepEqual(overlay.segments.map((s) => s.key), ['1-3', '5-5', '7-7', '9-9', '11-11']);
  assert.equal(overlay.currentSource, SRC);
  assert.equal(overlay.segmentOf('7-7')!.curStart, 7);
  assert.equal(overlay.segmentOf('7-7')!.source, '[^a]: note');
  assert.equal(overlay.segmentOf('1-3')!.frontmatter, true);
  assert.equal(overlay.segmentOf('2-2'), undefined);
});

test('an override moves every later segment, footnote item included', () => {
  const overlay = buildOverlay(SRC, DOC_ORDER, { '5-5': 'P1 edited.[^a]\n\nP1b.' })!;
  assert.equal(overlay.segmentOf('5-5')!.edited, true);
  assert.deepEqual(
    overlay.segments.map((s) => [s.key, s.curStart, s.curEnd]),
    [['1-3', 1, 3], ['5-5', 5, 7], ['7-7', 9, 9], ['9-9', 11, 11], ['11-11', 13, 13]],
  );
  assert.equal(overlay.blockAt(9, 9)!.source, '[^a]: note');
  assert.deepEqual(overlay.applyEdit(13, 13, 'List!'), { key: '11-11', next: 'List!' });
  assert.equal(typeof overlay.applyEdit(7, 9, 'x'), 'string');
  assert.equal(overlay.currentSource.split('\n')[8], '[^a]: note');
});

test('overlapping or out-of-range stamps yield no overlay', () => {
  assert.equal(buildOverlay(SRC, [range(5, 7), range(7, 7)], {}), null);
  assert.equal(buildOverlay(SRC, [range(11, 12)], {}), null);
});

test('hasJsxSource reads component tags only', () => {
  assert.equal(hasJsxSource('<Hero title="x" />'), true);
  assert.equal(hasJsxSource('<div class="x">'), false);
});
