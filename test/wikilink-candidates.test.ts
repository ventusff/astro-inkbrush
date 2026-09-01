/**
 * [[ completion candidates (lib/wikilink-core.ts wikilinkCandidates) — the
 * resolver read backwards: a note offers its own language's pages, spelled
 * the way a link in that language is written; another language opens only
 * when its prefix is spelled; and every spelling offered resolves, from the
 * source note, to the note it was offered for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildWikilinkResolver,
  localePrefixOf,
  wikilinkCandidates,
  type WikiNoteInfo,
} from '../src/lib/wikilink-core.ts';

const LOCALES = [
  { code: 'en', prefix: '' },
  { code: 'zh', prefix: 'zh/' },
  { code: 'de', prefix: 'de/' },
];

const NOTES: WikiNoteInfo[] = [
  { id: 'guide', title: 'Guide', brand: 'The Guide', aliases: ['handbook'] },
  { id: 'setup', title: 'Setup', aliases: [] },
  { id: 'english-only', title: 'English only', aliases: [] },
  { id: 'design/tokens', title: 'Design tokens', aliases: [] },
  { id: 'zh/guide', title: '指南', brand: '指南手册', aliases: ['手册'] },
  { id: 'zh/setup', title: '安装', aliases: [] },
  { id: 'zh/design/tokens', title: '设计令牌', aliases: [] },
  { id: 'zh', title: '中文首页', aliases: [] },
  { id: 'de/guide', title: 'Leitfaden', aliases: [] },
];

const ids = (list: { note: WikiNoteInfo }[]): string[] => list.map((c) => c.note.id);
const spellings = (list: { spelling: string }[]): string[] => list.map((c) => c.spelling);

test('localePrefixOf: the prefix an id carries, the bare locale segment included, else the default', () => {
  assert.equal(localePrefixOf('zh/guide', LOCALES), 'zh/');
  assert.equal(localePrefixOf('zh', LOCALES), 'zh/');
  assert.equal(localePrefixOf('guide', LOCALES), '');
  assert.equal(localePrefixOf('design/tokens', LOCALES), '');
  // a table without a row for the default locale reads the same
  assert.equal(localePrefixOf('guide', LOCALES.filter((l) => l.prefix !== '')), '');
  assert.equal(localePrefixOf('de/guide', LOCALES.filter((l) => l.prefix !== '')), 'de/');
});

test('a note offers its own language only, spelled without the locale prefix', () => {
  const fromZh = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'zh/setup' });
  assert.deepEqual(ids(fromZh).sort(), ['zh', 'zh/design/tokens', 'zh/guide', 'zh/setup']);
  assert.deepEqual(spellings(fromZh).sort(), ['design/tokens', 'guide', 'setup', 'zh']);

  const fromEn = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'setup' });
  assert.deepEqual(ids(fromEn).sort(), ['design/tokens', 'english-only', 'guide', 'setup']);
  assert.deepEqual(spellings(fromEn).sort(), ['design/tokens', 'english-only', 'guide', 'setup']);

  // no source note: the default locale
  assert.deepEqual(ids(wikilinkCandidates({ notes: NOTES, locales: LOCALES })).sort(), ids(fromEn).sort());
});

test('a spelled locale prefix opens that language by full id', () => {
  const de = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'zh/setup', query: 'de/' });
  assert.deepEqual(spellings(de), ['de/guide']);
  const deQuery = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'setup', query: 'de/gu' });
  assert.deepEqual(spellings(deQuery), ['de/guide']);
  // the own prefix spelled out is an exact id as well
  const zhFull = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'zh/setup', query: 'zh/g' });
  assert.deepEqual(spellings(zhFull), ['zh/guide']);
  // a path segment that is not a locale opens nothing special
  const design = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'zh/setup', query: 'design/' });
  assert.deepEqual(spellings(design), ['design/tokens']);
  assert.deepEqual(ids(design), ['zh/design/tokens']);
});

test('matching is a case-insensitive substring of spelling, brand, alias or title, ranked in that order', () => {
  const zh = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'zh/setup', query: '手册' });
  assert.deepEqual(ids(zh), ['zh/guide']);
  const en = wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId: 'setup', query: 'GUIDE' });
  assert.deepEqual(spellings(en), ['guide']);
  // spelling prefix beats spelling substring beats brand/alias beats title
  const notes: WikiNoteInfo[] = [
    { id: 'zz-title', title: 'a term here', aliases: [] },
    { id: 'zz-alias', title: 'Z', aliases: ['term'] },
    { id: 'has-term-inside', title: 'Z', aliases: [] },
    { id: 'term-first', title: 'Z', aliases: [] },
  ];
  assert.deepEqual(spellings(wikilinkCandidates({ notes, locales: LOCALES, query: 'term' })), [
    'term-first',
    'has-term-inside',
    'zz-alias',
    'zz-title',
  ]);
  assert.deepEqual(spellings(wikilinkCandidates({ notes, locales: LOCALES, query: 'nothing' })), []);
});

test('every spelling offered resolves, from the source note, to the note it was offered for', () => {
  const resolve = buildWikilinkResolver({ notes: () => NOTES, urlFor: (id) => `/${id}/`, locales: LOCALES });
  const sources = [undefined, 'setup', 'design/tokens', 'zh/setup', 'zh', 'de/guide'];
  const queries = ['', 'g', 'de/', 'zh/', 'design/', '手', 'GUIDE'];
  let checked = 0;
  for (const fromNoteId of sources) {
    for (const query of queries) {
      for (const { spelling, note } of wikilinkCandidates({ notes: NOTES, locales: LOCALES, fromNoteId, query })) {
        const res = resolve(spelling, fromNoteId);
        assert.equal(res.kind, 'ok', `[[${spelling}]] from ${fromNoteId ?? '(none)'}: ${JSON.stringify(res)}`);
        assert.equal((res as { id: string }).id, note.id, `[[${spelling}]] from ${fromNoteId ?? '(none)'}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 40, `round-trip covered ${checked} candidates`);
});

test('the engine default table (no default-locale row) scopes the same way', () => {
  const notes: WikiNoteInfo[] = [
    { id: 'guide', title: '指南', aliases: [] },
    { id: 'en/guide', title: 'Guide', aliases: [] },
    { id: 'de/guide', title: 'Leitfaden', aliases: [] },
  ];
  assert.deepEqual(spellings(wikilinkCandidates({ notes, fromNoteId: 'en/other' })), ['guide']);
  assert.deepEqual(ids(wikilinkCandidates({ notes, fromNoteId: 'en/other' })), ['en/guide']);
  assert.deepEqual(ids(wikilinkCandidates({ notes, fromNoteId: 'other' })), ['guide']);
  assert.deepEqual(spellings(wikilinkCandidates({ notes, fromNoteId: 'other', query: 'de/' })), ['de/guide']);
});
