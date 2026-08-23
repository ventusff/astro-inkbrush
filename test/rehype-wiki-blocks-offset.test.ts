/**
 * Stamps are RAW file lines. A pipeline that strips the frontmatter before
 * parsing (body-relative positions, body-only vfile value) gets the
 * frontmatter offset added from the raw file on disk; a pipeline whose
 * positions already count the frontmatter gets none.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { VFile } from 'vfile';

import { rehypeWikiBlocks } from '../src/lib/rehype-wiki-blocks.ts';

const RAW = '---\ntitle: T\ndesc: d\n---\n\nIntro paragraph.\n\n## Heading\n';
const BODY = '\nIntro paragraph.\n\n## Heading\n';

const el = (tag: string, start: number, end: number) => ({
  type: 'element',
  tagName: tag,
  properties: {},
  children: [],
  position: { start: { line: start, column: 1 }, end: { line: end, column: 1 } },
});
const stamps = (tree: { children: { properties?: Record<string, unknown> }[] }) =>
  tree.children.map((c) => c.properties?.['data-wiki-src']);

test('body-relative positions with a frontmatter file gain the offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, RAW);
    // Astro's .md path: value and positions are body-only (intro at body 2)
    const tree = { type: 'root', children: [el('p', 2, 2), el('h2', 4, 4)] };
    rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path }));
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']); // raw lines
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raw-counting positions (MDX path) are stamped unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.mdx');
    writeFileSync(path, RAW);
    const tree = { type: 'root', children: [el('p', 6, 6), el('h2', 8, 8)] };
    rehypeWikiBlocks()(tree as never, new VFile({ value: RAW, path }));
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file without frontmatter is stamped unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, BODY);
    const tree = { type: 'root', children: [el('p', 2, 2)] };
    rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path }));
    assert.deepEqual(stamps(tree as never), ['2-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
