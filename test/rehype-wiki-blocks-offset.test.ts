/**
 * Stamps are RAW file lines. The transform is async (fs loads lazily so
 * browser bundles never resolve it) — direct calls await it. A pipeline that
 * strips the frontmatter before parsing (body-relative positions, body-only
 * vfile value — trimmed or not) gets the offset measured from where that
 * body sits in the raw file on disk; a pipeline whose positions already
 * count the frontmatter gets none.
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
/** Astro's .md content entries: the body with leading/trailing blanks trimmed */
const BODY_TRIMMED = 'Intro paragraph.\n\n## Heading';

const el = (tag: string, start: number, end: number) => ({
  type: 'element',
  tagName: tag,
  properties: {},
  children: [],
  position: { start: { line: start, column: 1 }, end: { line: end, column: 1 } },
});
/** the frontmatter anchor's range when the tree opens with one, else null */
const anchorOf = (tree: { children: { tagName?: string; properties?: Record<string, unknown> }[] }) => {
  const first = tree.children[0];
  return first?.tagName === 'template' && first.properties?.['data-wiki-frontmatter'] !== undefined
    ? first.properties['data-wiki-src']
    : null;
};
/** body stamps (the frontmatter anchor, when present, is asserted separately) */
const stamps = (tree: { children: { properties?: Record<string, unknown> }[] }) =>
  tree.children
    .filter((c) => c.properties?.['data-wiki-frontmatter'] === undefined)
    .map((c) => c.properties?.['data-wiki-src']);

test('body-relative positions with a frontmatter file gain the offset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, RAW);
    // Astro's .md path: value and positions are body-only (intro at body 2)
    const tree = { type: 'root', children: [el('p', 2, 2), el('h2', 4, 4)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path }));
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']); // raw lines
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a trimmed body (Astro .md content entry) is located in the file, not line-counted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, RAW);
    // intro at body line 1, heading at 3; the trailing newline of the file
    // was trimmed too, so a line-count difference would read 6, not 5
    const tree = { type: 'root', children: [el('p', 1, 1), el('h2', 3, 3)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: BODY_TRIMMED, path }));
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']);
    assert.equal(anchorOf(tree as never), '1-4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raw-counting positions (MDX path) are stamped unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.mdx');
    writeFileSync(path, RAW);
    const tree = { type: 'root', children: [el('p', 6, 6), el('h2', 8, 8)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: RAW, path }));
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file without frontmatter is stamped unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, BODY);
    const tree = { type: 'root', children: [el('p', 2, 2)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path }));
    assert.deepEqual(stamps(tree as never), ['2-2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- the frontmatter anchor ---- */

test('a note with frontmatter gets the anchor first, spanning fence to fence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.mdx');
    writeFileSync(path, RAW);
    const tree = { type: 'root', children: [el('p', 6, 6), el('h2', 8, 8)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: RAW, path }));
    assert.equal(anchorOf(tree as never), '1-4');
    assert.deepEqual(stamps(tree as never), ['6-6', '8-8']); // body stamps untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the body-only pipeline (Astro .md) gets the anchor too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const path = join(dir, 'index.md');
    writeFileSync(path, RAW);
    const tree = { type: 'root', children: [el('p', 2, 2)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path }));
    assert.equal(anchorOf(tree as never), '1-4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no frontmatter, no anchor; a fragment rendered against the note gets none either', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-stamp-'));
  try {
    const bare = join(dir, 'bare.md');
    writeFileSync(bare, BODY);
    const tree = { type: 'root', children: [el('p', 2, 2)] };
    await rehypeWikiBlocks()(tree as never, new VFile({ value: BODY, path: bare }));
    assert.equal(anchorOf(tree as never), null);

    const path = join(dir, 'index.mdx');
    writeFileSync(path, RAW);
    // a mid-note fragment (the editor preview) is neither the file nor its tail
    const fragment = { type: 'root', children: [el('p', 1, 1)] };
    await rehypeWikiBlocks()(fragment as never, new VFile({ value: 'Intro paragraph.', path }));
    assert.equal(anchorOf(fragment as never), null);
    // no file behind the value (the browser playground): nothing to anchor
    const loose = { type: 'root', children: [el('p', 1, 1)] };
    await rehypeWikiBlocks()(loose as never, new VFile({ value: RAW }));
    assert.equal(anchorOf(loose as never), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
