/**
 * A note page's actions for its other languages: the default locale's page
 * jumps to every existing twin, a translation's page jumps nowhere, and a
 * missing language is offered for translation unless the note is a copy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCALES, languageActions, onDefaultLocale } from '../src/wiki/shared/locales.ts';
import type { NoteLocaleInfo } from '../src/wiki/shared/types.ts';

const origin = { wiki: 'peer', revision: '0123456789abcdef', synced: '2026-01-01T00:00:00Z' };

/** the locales of note `guide` viewed in `current`, with the languages in `existing` on disk */
function localesOf(current: string, existing: string[]): NoteLocaleInfo[] {
  return LOCALES.map((l) => ({
    code: l.code,
    prefix: l.prefix,
    id: `${l.prefix}guide`,
    label: l.label,
    exists: existing.includes(l.code),
    current: l.code === current,
  }));
}

const summary = (locales: NoteLocaleInfo[], copy = false): string[] =>
  languageActions({ locales, origin: copy ? origin : undefined }).map(({ kind, locale }) => `${kind} ${locale.id}`);

test('the default locale page jumps to every existing twin, in table order', () => {
  assert.deepEqual(summary(localesOf('zh', ['zh', 'en', 'de'])), ['jump en/guide', 'jump de/guide']);
  assert.deepEqual(summary(localesOf('zh', ['zh', 'en'])), ['jump en/guide', 'translate de/guide']);
  assert.deepEqual(summary(localesOf('zh', ['zh'])), ['translate en/guide', 'translate de/guide']);
});

test('an English or German page jumps to no other language', () => {
  for (const current of ['en', 'de']) {
    assert.deepEqual(summary(localesOf(current, ['zh', 'en', 'de'])), [], current);
  }
  assert.deepEqual(summary(localesOf('en', ['zh', 'en'])), ['translate de/guide']);
  assert.deepEqual(summary(localesOf('de', ['zh', 'de'])), ['translate en/guide']);
  assert.deepEqual(summary(localesOf('en', ['en'])), ['translate guide', 'translate de/guide']);
});

test('a copy offers no translation: its languages are written at its origin', () => {
  assert.deepEqual(summary(localesOf('zh', ['zh', 'en']), true), ['jump en/guide']);
  assert.deepEqual(summary(localesOf('en', ['zh', 'en']), true), []);
});

test('only the default locale page links into other languages', () => {
  assert.equal(onDefaultLocale(localesOf('zh', ['zh'])), true);
  assert.equal(onDefaultLocale(localesOf('en', ['zh', 'en'])), false);
  assert.equal(onDefaultLocale(localesOf('de', ['zh', 'de'])), false);
  assert.equal(onDefaultLocale([]), false);
});

test('a deployment whose default locale is English links from English pages only', () => {
  const locales: NoteLocaleInfo[] = [
    { code: 'en', prefix: '', id: 'guide', label: 'English', exists: true, current: false },
    { code: 'zh', prefix: 'zh/', id: 'zh/guide', label: '中文', exists: true, current: true },
  ];
  assert.deepEqual(summary(locales), []);
  const onEnglish = locales.map((l) => ({ ...l, current: l.code === 'en' }));
  assert.deepEqual(summary(onEnglish), ['jump zh/guide']);
});
