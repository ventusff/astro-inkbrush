/**
 * translation-declaration: finding i18n.config.json, telling which page a file
 * is in prefix and suffix layouts, and which language a page is written in
 * first — by the lock, else by where the page exists.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findTranslationDeclaration, isSourcePage, pageOf, readTranslationDeclaration } from '../src/lib/translation-declaration.ts';

function repo(config: unknown, files: Record<string, string> = {}, lock?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'translation-declaration-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'i18n.config.json'), JSON.stringify(config));
  if (lock !== undefined) writeFileSync(join(dir, 'i18n.lock'), JSON.stringify(lock));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const PREFIX = {
  locales: ['zh', 'en', 'de'],
  units: [
    { kind: 'messages', file: 'src/i18n/{locale}.json' },
    { kind: 'pages', root: 'site/src/docs/', file: '{id}/index.{mdx,md}', layout: 'prefix', exclude: ['_meta/**', 'draft?/index.mdx', '.hidden/**'] },
  ],
};

test('the declaration is found above the content root, up to the repository top', () => {
  const dir = repo({});
  try {
    mkdirSync(join(dir, 'site/src/docs'), { recursive: true });
    assert.equal(findTranslationDeclaration(join(dir, 'site/src/docs')), join(dir, 'i18n.config.json'));
    const inner = join(dir, 'site/inner');
    mkdirSync(join(inner, '.git'), { recursive: true });
    assert.equal(findTranslationDeclaration(inner), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prefix layout: the default language at the root, the others under their directory; excluded paths are no page in any language', () => {
  const dir = repo(PREFIX);
  try {
    const d = readTranslationDeclaration(join(dir, 'i18n.config.json'));
    assert.equal(d.source, 'zh');
    assert.equal(d.pages[0]!.key, 'site/src/docs');
    const at = (p: string) => {
      const page = pageOf(d, join(dir, 'site/src/docs', p));
      return page && `${page.locale}:${page.id}:${page.choices.join(',')}`;
    };
    assert.equal(at('bank/locate/index.mdx'), 'zh:bank/locate:mdx');
    assert.equal(at('en/bank/locate/index.md'), 'en:bank/locate:md');
    assert.equal(at('bank/locate/notes.mdx'), null);
    assert.equal(at('_meta/x/index.mdx'), null);
    assert.equal(at('de/_meta/x/index.mdx'), null);
    assert.equal(at('draft1/index.mdx'), null);
    assert.equal(at('.hidden/x/index.mdx'), null);
    assert.equal(pageOf(d, join(dir, 'elsewhere/x/index.mdx')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suffix layout: the language in the file name; the default leaves it out with its separator unless bareDefault is false', () => {
  const at = (config: unknown, p: string) => {
    const dir = repo(config);
    try {
      return pageOf(readTranslationDeclaration(join(dir, 'i18n.config.json')), join(dir, 'docs', p))?.locale ?? null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const bare = { locales: ['en', 'zh'], units: [{ kind: 'pages', root: 'docs', file: '{id}.{locale}.md', layout: 'suffix' }] };
  assert.equal(at(bare, 'about.zh.md'), 'zh');
  assert.equal(at(bare, 'about.md'), 'en');
  const named = { locales: ['zh', 'en'], units: [{ kind: 'pages', root: 'docs', file: '{id}/index-{locale}.md', layout: 'suffix', bareDefault: false }] };
  assert.equal(at(named, 'about/index-zh.md'), 'zh');
  assert.equal(at(named, 'about/index-en.md'), 'en');
  assert.equal(at(named, 'about/index.md'), null);
});

test('a page\'s source: the lock\'s record, else the declaration\'s source where the page exists, else its first language', () => {
  const dir = repo(
    PREFIX,
    {
      'site/src/docs/recorded/index.mdx': '',
      'site/src/docs/en/recorded/index.mdx': '',
      'site/src/docs/both/index.mdx': '',
      'site/src/docs/en/both/index.mdx': '',
      'site/src/docs/en/english-only/index.mdx': '',
      'site/src/docs/de/english-only/index.mdx': '',
    },
    { version: 1, units: { 'pages:site/src/docs:recorded': { source: 'en', zh: 'a', en: 'b' } } },
  );
  try {
    const d = readTranslationDeclaration(join(dir, 'i18n.config.json'));
    const source = (p: string) => isSourcePage(d, join(dir, 'site/src/docs', p));
    assert.equal(source('recorded/index.mdx'), false);
    assert.equal(source('en/recorded/index.mdx'), true);
    assert.equal(source('both/index.mdx'), true);
    assert.equal(source('en/both/index.mdx'), false);
    assert.equal(source('en/english-only/index.mdx'), true);
    assert.equal(source('de/english-only/index.mdx'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the source is zh when listed and not named, else the first language; a null declaration is empty', () => {
  const at = (config: unknown) => {
    const dir = repo(config);
    try {
      return readTranslationDeclaration(join(dir, 'i18n.config.json')).source;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(at({ locales: ['en', 'zh'] }), 'zh');
  assert.equal(at({ locales: ['en', 'de'] }), 'en');
  assert.equal(at({ locales: ['zh', 'en'], source: 'en' }), 'en');
  assert.equal(at({}), '');
  assert.equal(at(null), '');
});
