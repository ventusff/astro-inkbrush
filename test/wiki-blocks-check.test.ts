/**
 * The block-stamp invariants: well-formed, disjoint, reachable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockStampProblems } from '../src/lib/wiki-blocks-check.ts';

const el = (tagName: string, stamp?: string, extra: Record<string, unknown> = {}) => ({
  type: 'element',
  tagName,
  properties: { ...(stamp === undefined ? {} : { 'data-wiki-src': stamp }), ...extra },
  children: [] as unknown[],
});
const root = (...children: unknown[]) => ({ type: 'root', children }) as never;

test('a sound block map has no problems', () => {
  const tree = root(
    el('template', '1-3', { 'data-wiki-frontmatter': '' }),
    el('p', '5-5'),
    el('template', '7-9', { 'data-wiki-jsx': 'Hero' }),
    { type: 'mdxJsxFlowElement', name: 'Hero', children: [] },
    el('template', '11-12', { 'data-wiki-html': '' }),
    { type: 'raw', value: '<div></div>' },
    {
      ...el('section', undefined, { dataFootnotes: true }),
      children: [{ ...el('ol'), children: [el('li', '14-14'), el('li', '16-17')] }],
    },
  );
  assert.deepEqual(blockStampProblems(tree, 17), []);
});

test('overlapping and malformed ranges are problems', () => {
  const overlap = blockStampProblems(root(el('p', '1-3'), el('ul', '3-4')));
  assert.equal(overlap.length, 1);
  assert.match(overlap[0]!, /<p> L1-3 and <ul> L3-4 overlap/);
  assert.match(blockStampProblems(root(el('p', 'abc')))[0]!, /malformed range "abc"/);
  assert.match(blockStampProblems(root(el('p', '4-2')))[0]!, /malformed range "4-2"/);
  assert.match(blockStampProblems(root(el('p', '8-9')), 8)[0]!, /runs past the last line \(8\)/);
});

test('an unstamped block, a raw block without an anchor and a bare footnote item are unreachable', () => {
  const tree = root(
    el('div'),
    { type: 'raw', value: '<hr>' },
    el('template'),
    {
      ...el('section', undefined, { dataFootnotes: true }),
      children: [{ ...el('ol'), children: [el('li')] }],
    },
  );
  const problems = blockStampProblems(tree);
  assert.deepEqual(
    problems.map((p) => p.replace(/ has no source range.*$/, '')),
    ['<div>', 'raw', '<li> (footnote)'],
  );
});
