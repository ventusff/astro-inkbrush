/**
 * wikilink-core is the module browser bundles load (the playground's
 * activation chunk, browser-side render pipelines): it must stay free of
 * imports — no Node builtins, no parser construction, no frontmatter
 * dependency — and wikilinks.ts must keep re-exporting it, so the public
 * astro-inkbrush/wikilinks surface is unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as core from '../src/lib/wikilink-core.ts';
import * as full from '../src/lib/wikilinks.ts';

test('wikilink-core imports nothing', () => {
  const src = readFileSync(new URL('../src/lib/wikilink-core.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, []);
  assert.doesNotMatch(src, /\bimport\(/);
});

test('wikilinks re-exports the core and keeps the scanner and extractor', () => {
  for (const name of ['WIKILINK_RE', 'defaultSlugify', 'buildWikilinkResolver', 'remarkWikilinks'] as const) {
    assert.equal(full[name], core[name], name);
  }
  for (const name of ['noteInfoFromSource', 'scanNotes', 'cachedScan', 'maskNonProse', 'extractWikilinks'] as const) {
    assert.equal(typeof full[name], 'function', name);
  }
});
