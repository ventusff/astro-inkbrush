/**
 * The chrome's string tables: every language carries every key, each
 * worded entry yields text, and the page's `<html lang>` picks the table.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENGLISH_ERRORS } from '../src/wiki/shared/errors.ts';
import { STRINGS, UI_LOCALES, uiLocaleOf, type UiLocale } from '../src/wiki/client/strings.ts';

/** an argument for any worded entry: reads as a string, a number and a
 *  record of parameters at once */
const ANY: unknown = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => 'x';
      if (prop === 'roles') return ['admin', 'member'];
      const value = ('x' as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind('x') : (value ?? 'x');
    },
  },
);

/** the table's shape: every path to an entry, with the entry's kind */
function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [`${path}()`];
  if (typeof value === 'string') return [path];
  if (Array.isArray(value)) return [`${path}[${value.length}]`, ...value.flatMap((item, i) => shape(item, `${path}[${i}]`))];
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .flatMap((key) => shape((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
  }
  return [`${path}:${typeof value}`];
}

/** every worded entry of a table, as [path, text] */
function texts(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'function') {
    const out = (value as (...args: unknown[]) => unknown)(ANY, ANY, ANY);
    return [[`${path}()`, String(out)]];
  }
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => texts(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => texts(item, path ? `${path}.${key}` : key));
  }
  return [];
}

test('every language carries exactly the keys of every other', () => {
  const english = shape(STRINGS.en);
  for (const locale of UI_LOCALES) {
    assert.deepEqual(shape(STRINGS[locale]), english, `${locale} differs from en`);
  }
});

test('every failure code is worded in every language', () => {
  const codes = Object.keys(ENGLISH_ERRORS).sort();
  for (const locale of UI_LOCALES) {
    assert.deepEqual(Object.keys(STRINGS[locale].errors).sort(), codes, `${locale} error codes`);
  }
});

test('every entry yields text in every language', () => {
  for (const locale of UI_LOCALES) {
    for (const [path, text] of texts(STRINGS[locale])) {
      assert.ok(text.trim().length > 0, `${locale} ${path} is empty`);
    }
  }
});

test('a German or English table carries no Chinese, a Chinese one is not the English one', () => {
  const han = /\p{Script=Han}/u;
  for (const locale of ['en', 'de'] as const) {
    for (const [path, text] of texts(STRINGS[locale])) {
      assert.ok(!han.test(text), `${locale} ${path} has Chinese: ${text}`);
    }
  }
  const en = new Map(texts(STRINGS.en));
  for (const locale of ['zh', 'de'] as const) {
    // the entries that are names, terms or sample addresses read the same
    // in every language
    const same = texts(STRINGS[locale]).filter(([path, text]) => en.get(path) === text && /[a-z]{4}/i.test(text));
    const allowed = /^(auth\.(provider\.\w|emailPlaceholder)|identity\.(emailPlaceholder|colName|namePlaceholder)|share\.link|sync\.copy\.revision)/;
    for (const [path, text] of same) {
      assert.match(path, allowed, `${locale} ${path} is still English: ${text}`);
    }
  }
});

test("the page's language picks the table: zh*, de*, anything else English", () => {
  const cases: Array<[string, UiLocale]> = [
    ['zh-CN', 'zh'],
    ['zh', 'zh'],
    ['de', 'de'],
    ['de-DE', 'de'],
    ['DE-ch', 'de'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['ja', 'en'],
    ['dex', 'en'],
    ['', 'en'],
  ];
  for (const [lang, locale] of cases) assert.equal(uiLocaleOf(lang), locale, lang);
});

test('the active table and the language names follow <html lang> at load', async () => {
  const globals = globalThis as { document?: unknown };
  const saved = globals.document;
  try {
    for (const [lang, locale, chinese] of [
      ['de-DE', 'de', 'Chinesisch'],
      ['zh-CN', 'zh', '中文'],
      ['en', 'en', 'Chinese'],
    ] as const) {
      globals.document = { documentElement: { lang } };
      const mod = (await import(`../src/wiki/client/strings.ts?lang=${lang}`)) as typeof import('../src/wiki/client/strings.ts');
      assert.equal(mod.uiLocale, locale);
      assert.equal(mod.S.blocks.focusHint, mod.STRINGS[locale].blocks.focusHint);
      // a note language is named in the page's language (a Chinese page
      // keeps the locale table's own label)
      assert.equal(mod.languageName('zh', '中文'), chinese);
    }
  } finally {
    globals.document = saved;
  }
});
