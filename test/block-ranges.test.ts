/**
 * Blocks a rehype plugin re-renders lose their position. One such block is
 * located by the gap between its neighbours; several in one gap each take the
 * range the dialect recorded at parse time — display formulas written back to
 * back stay separately editable.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { VFile } from 'vfile';

import { checkContent } from '../scripts/check-content.mjs';
import { recordedBlockRanges, remarkBlockRanges } from '../src/lib/block-ranges.ts';
import { rehypeWikiBlocks } from '../src/lib/rehype-wiki-blocks.ts';

const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 1 } });
const el = (tag: string, position?: ReturnType<typeof at>) => ({
  type: 'element',
  tagName: tag,
  properties: {} as Record<string, unknown>,
  children: [],
  ...(position ? { position } : {}),
});
const stampsOf = (tree: { children: { properties?: Record<string, unknown> }[] }) =>
  tree.children.map((c) => c.properties?.['data-wiki-src']);

const SOURCE = 'a\n\n$$\nx\n$$\n$$\ny\n$$\n\nb\n';

test('the dialect records every top-level block of the parsed tree', () => {
  const file = new VFile({ value: SOURCE });
  remarkBlockRanges()({ children: [{ position: at(1, 1) }, { position: at(3, 5) }, {}, { position: at(6, 8) }] }, file);
  assert.deepEqual(recordedBlockRanges(file), [
    { start: 1, end: 1 },
    { start: 3, end: 5 },
    { start: 6, end: 8 },
  ]);
  assert.deepEqual(recordedBlockRanges(new VFile('')), []);
});

test('position-less blocks sharing a gap each take their recorded range', () => {
  const tree = { type: 'root', children: [el('p', at(1, 1)), el('span'), el('span'), el('p', at(10, 10))] };
  const file = new VFile({ value: SOURCE });
  file.data['wikiBlockRanges'] = [at(1, 1), at(3, 5), at(6, 8), at(10, 10)].map((p) => ({ start: p.start.line, end: p.end.line }));
  rehypeWikiBlocks()(tree as never, file);
  assert.deepEqual(stampsOf(tree), ['1-1', '3-5', '6-8', '10-10']);
});

test('without a matching record the first block takes the gap, as a lone block does', () => {
  const pair = { type: 'root', children: [el('p', at(1, 1)), el('span'), el('span'), el('p', at(10, 10))] };
  rehypeWikiBlocks()(pair as never, new VFile({ value: SOURCE }));
  assert.deepEqual(stampsOf(pair), ['1-1', '3-8', undefined, '10-10']);
  const lone = { type: 'root', children: [el('p', at(1, 1)), el('span'), el('p', at(10, 10))] };
  rehypeWikiBlocks()(lone as never, new VFile({ value: SOURCE }));
  assert.deepEqual(stampsOf(lone), ['1-1', '3-8', '10-10']);
});

test('check-content: display formulas written back to back keep a sound block map under KaTeX', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-ranges-'));
  try {
    for (const name of ['md/index.md', 'mdx/index.mdx']) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), SOURCE);
    }
    const site = { remarkPlugins: [remarkMath], rehypePlugins: [[rehypeKatex, { output: 'htmlAndMathml' }]] };
    const { checked, findings } = await checkContent(root, { site });
    assert.equal(checked, 2);
    assert.deepEqual(findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
