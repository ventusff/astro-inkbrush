/**
 * Unit tests for the [[wikilink]] implementation: the shared regex, the
 * resolver's lookup order, the pipeline-agnostic remark transform, the
 * mask/extract helpers used by backlink indexes, and the frontmatter scanner
 * (over a small fixture tree in test/fixtures/notes/).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  WIKILINK_RE,
  buildWikilinkResolver,
  cachedScan,
  defaultSlugify,
  extractWikilinks,
  maskNonProse,
  remarkWikilinks,
  scanNotes,
  type WikiNoteInfo,
} from '../src/lib/wikilinks.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/notes', import.meta.url));

/* ---------------- the shared regex ---------------- */

function matches(text: string): string[] {
  WIKILINK_RE.lastIndex = 0;
  return [...text.matchAll(WIKILINK_RE)].map((m) => m[0]);
}

test('the regex matches the three wikilink forms', () => {
  assert.deepEqual(matches('a [[note]] b'), ['[[note]]']);
  assert.deepEqual(matches('a [[note|label]] b'), ['[[note|label]]']);
  assert.deepEqual(matches('a [[note#anchor]] b'), ['[[note#anchor]]']);
  assert.deepEqual(matches('a [[note#anchor|label]] b'), ['[[note#anchor|label]]']);
});

test('embeds and citation-style links are excluded', () => {
  assert.deepEqual(matches('an ![[embed.png]] image'), []);
  assert.deepEqual(matches('a citation [[1]](#ref-one) marker'), []);
});

/* ---------------- resolver lookup order ---------------- */

function resolver(notes: WikiNoteInfo[]) {
  return buildWikilinkResolver({ notes: () => notes, urlFor: (id) => `/${id}/` });
}

test('the source note’s locale mirror wins over the bare id', () => {
  const resolve = resolver([
    { id: 'guide', title: 'Guide', aliases: [] },
    { id: 'en/guide', title: 'Guide (EN)', aliases: [] },
  ]);
  assert.deepEqual(resolve('guide', 'en/other-note'), {
    kind: 'ok',
    id: 'en/guide',
    url: '/en/guide/',
    title: 'Guide (EN)',
  });
  // from an unprefixed note, and with no source note at all, the bare id wins
  assert.equal((resolve('guide', 'other-note') as { id: string }).id, 'guide');
  assert.equal((resolve('guide') as { id: string }).id, 'guide');
  // an explicit prefix is an exact id
  assert.equal((resolve('en/guide') as { id: string }).id, 'en/guide');
});

test('an exact id beats an alias of the same spelling', () => {
  const resolve = resolver([
    { id: 'setup', title: 'Setup Page', aliases: [] },
    { id: 'getting-started', title: 'Getting Started', aliases: ['setup'] },
  ]);
  assert.equal((resolve('setup') as { id: string }).id, 'setup');
  // id lookup is case-sensitive; the fallback key lookup is not
  assert.equal((resolve('SETUP') as { id: string }).id, 'getting-started');
});

test('alias, brand and title all resolve, case-insensitively', () => {
  const resolve = resolver([
    { id: 'sample-note', title: 'Sample Note', brand: 'Sampler', aliases: ['the sample'] },
  ]);
  for (const target of ['the sample', 'The Sample', 'Sampler', 'sample note']) {
    assert.equal((resolve(target) as { id: string }).id, 'sample-note', target);
  }
});

test('a key claimed by two notes is ambiguous, an unknown key is missing', () => {
  const resolve = resolver([
    { id: 'x-note', title: 'Overlap', aliases: [] },
    { id: 'y-note', title: 'Y', aliases: ['overlap'] },
  ]);
  assert.deepEqual(resolve('overlap'), { kind: 'ambiguous', candidates: ['x-note', 'y-note'] });
  assert.deepEqual(resolve('nothing-here'), { kind: 'missing' });
});

/* ---------------- the remark transform ---------------- */

interface AnyNode {
  type: string;
  value?: string;
  url?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: AnyNode[];
}

function collect(tree: AnyNode, type: string): AnyNode[] {
  const out: AnyNode[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === type) out.push(n);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

function transform(
  markdown: string,
  notes: WikiNoteInfo[],
  extra: { path?: string; onBroken?: (b: { target: string; kind: string }) => void } = {},
): AnyNode {
  const tree = unified().use(remarkParse).parse(markdown) as unknown as AnyNode;
  remarkWikilinks({
    resolve: buildWikilinkResolver({ notes: () => notes, urlFor: (id) => `/${id}/` }),
    ...(extra.onBroken ? { onBroken: extra.onBroken } : {}),
  })(tree as never, { path: extra.path ?? 'sample-note/index.md' });
  return tree;
}

const NOTES: WikiNoteInfo[] = [
  { id: 'sample-note', title: 'Sample Note', aliases: [] },
  { id: 'getting-started', title: 'Getting Started', aliases: [] },
];

test('a resolved wikilink becomes a real link with the wikilink class', () => {
  const tree = transform('See [[sample-note]].', NOTES);
  const [link] = collect(tree, 'link');
  assert.ok(link);
  assert.equal(link.url, '/sample-note/');
  assert.deepEqual(link.data?.hProperties?.['className'], ['wikilink']);
  assert.equal(link.data?.hProperties?.['data-note'], 'sample-note');
  assert.equal(link.children?.[0]?.value, 'sample-note');
});

test('labels and anchors are honored, anchors slugified', () => {
  const tree = transform('Read [[getting-started#Deep Dive|read this]].', NOTES);
  const [link] = collect(tree, 'link');
  assert.equal(link?.url, '/getting-started/#deep-dive');
  assert.equal(link?.children?.[0]?.value, 'read this');
});

test('a miss renders a dead span and fires onBroken; the build survives', () => {
  const broken: { target: string; kind: string }[] = [];
  const tree = transform('See [[missing-note]].', NOTES, { onBroken: (b) => broken.push(b) });
  const [dead] = collect(tree, 'wikilinkDead');
  assert.ok(dead);
  assert.equal(dead.data?.hName, 'span');
  assert.deepEqual(dead.data?.hProperties?.['className'], ['wikilink', 'wikilink-dead']);
  assert.match(String(dead.data?.hProperties?.['title']), /missing-note/);
  assert.deepEqual(broken, [{ file: 'sample-note/index.md', target: 'missing-note', kind: 'missing' }]);
});

test('an ambiguous target is also a dead span, naming the candidates', () => {
  const notes: WikiNoteInfo[] = [
    { id: 'x-note', title: 'Overlap', aliases: [] },
    { id: 'y-note', title: 'Y', aliases: ['overlap'] },
  ];
  const broken: { target: string; kind: string }[] = [];
  const tree = transform('Pick [[overlap]].', notes, { onBroken: (b) => broken.push(b) });
  const [dead] = collect(tree, 'wikilinkDead');
  assert.match(String(dead?.data?.hProperties?.['title']), /x-note.*y-note/);
  assert.equal(broken[0]?.kind, 'ambiguous');
});

test('surrounding text is preserved around the replacement', () => {
  const tree = transform('before [[sample-note]] after', NOTES);
  const texts = collect(tree, 'text').map((t) => t.value);
  assert.deepEqual(texts, ['before ', 'sample-note', ' after']);
});

test('links, code and math are never descended into', () => {
  const tree = transform('`[[not-a-link]]` and [[1]](#ref-one)', NOTES);
  assert.deepEqual(collect(tree, 'wikilinkDead'), []);
  const codes = collect(tree, 'inlineCode');
  assert.equal(codes[0]?.value, '[[not-a-link]]');
});

test('an embed stays literal text', () => {
  const tree = transform('an ![[embed.png]] image', NOTES);
  assert.deepEqual(collect(tree, 'wikilinkDead'), []);
  assert.deepEqual(collect(tree, 'link'), []);
});

/* ---------------- mask & extract ---------------- */

const SOURCE = [
  '---',
  'title: Sample',
  '---',
  '',
  'prose [[sample-note]] here',
  '',
  '```',
  'fenced [[not-this]]',
  '```',
  '',
  'inline `[[nor-this]]` and [[getting-started#Deep Dive|label]]',
  '',
].join('\n');

test('maskNonProse blanks frontmatter, fences and inline code at equal length', () => {
  const masked = maskNonProse(SOURCE);
  assert.equal(masked.length, SOURCE.length);
  assert.equal(masked.split('\n').length, SOURCE.split('\n').length);
  assert.equal(masked.includes('not-this'), false);
  assert.equal(masked.includes('nor-this'), false);
  assert.equal(masked.includes('title: Sample'), false);
  assert.ok(masked.includes('[[sample-note]]'));
});

test('extractWikilinks returns prose links only, with valid offsets', () => {
  const links = extractWikilinks(SOURCE);
  assert.deepEqual(
    links.map((l) => ({ target: l.target, anchor: l.anchor, label: l.label })),
    [
      { target: 'sample-note', anchor: undefined, label: undefined },
      { target: 'getting-started', anchor: 'Deep Dive', label: 'label' },
    ],
  );
  for (const l of links) {
    assert.equal(SOURCE.slice(l.offset, l.offset + l.raw.length), l.raw);
  }
});

/* ---------------- fs scan over the fixture tree ---------------- */

test('scanNotes finds notes, skipping _meta, docs, dot-dirs and the root index', () => {
  const notes = scanNotes(FIXTURES);
  assert.deepEqual(
    notes.map((n) => n.id).sort(),
    ['bare-note', 'en/getting-started', 'getting-started', 'sample-note'],
  );
});

test('scanNotes reads title, brand and both alias spellings from frontmatter', () => {
  const byId = new Map(scanNotes(FIXTURES).map((n) => [n.id, n]));
  assert.deepEqual(byId.get('getting-started'), {
    id: 'getting-started',
    title: 'Getting Started',
    brand: undefined,
    aliases: ['setup', 'quick start'],
  });
  assert.deepEqual(byId.get('sample-note'), {
    id: 'sample-note',
    title: 'Sample Note',
    brand: 'Sampler',
    aliases: ['alias one', 'alias two'],
  });
  // no frontmatter → the id is the title
  assert.equal(byId.get('bare-note')?.title, 'bare-note');
});

test('cachedScan returns the same array within the TTL', () => {
  const scan = cachedScan(FIXTURES, 60_000);
  assert.equal(scan(), scan());
});

/* ---------------- slugify ---------------- */

test('defaultSlugify lowercases, hyphenates and keeps CJK', () => {
  assert.equal(defaultSlugify('Deep Dive'), 'deep-dive');
  assert.equal(defaultSlugify('A/B testing'), 'a-b-testing');
  assert.equal(defaultSlugify('第 2 节 · 概述'), '第-2-节-概述');
  assert.equal(defaultSlugify('!!!'), 'section');
});
