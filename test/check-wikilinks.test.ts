/**
 * check-wikilinks: every report class (missing, ambiguous, anchor,
 * unmatched, allowed), locale-mirror resolution, extra corpora, MDX sources, and the
 * site's own resolver and slugifier through --config — over
 * test/fixtures/wikinotes, test/fixtures/cards and test/fixtures/site-config.ts.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { anchorsOf, checkWikilinks, collectCorpus, loadSiteConfig, main } from '../scripts/check-wikilinks.mjs';
import { defaultSlugify } from '../src/lib/wikilinks.ts';

const NOTES = fileURLToPath(new URL('./fixtures/wikinotes', import.meta.url));
const CARDS = fileURLToPath(new URL('./fixtures/cards', import.meta.url));
const SITE_CONFIG = fileURLToPath(new URL('./fixtures/site-config.ts', import.meta.url));

interface Line {
  level: string;
  kind: string;
  note: string;
  message: string;
}
const lines = (report: Line[]): string[] => report.map((r) => `${r.level} ${r.kind} ${r.note}: ${r.message}`);

test('anchors: ATX headings slugged, closing hashes dropped, explicit {#id} kept, code excluded', () => {
  const text = ['## Deep Dive ##', '### Custom *Name* {#custom-id}', '```', '## Not A Heading', '```', '#notahashtag'].join('\n');
  assert.deepEqual([...anchorsOf(text, defaultSlugify)].sort(), ['custom-id', 'custom-name', 'deep-dive']);
});

test('anchors: duplicate headings take -2, -3 suffixes; setext headings count', () => {
  const text = ['Top Title', '=========', '', '## Setup', '', '## Setup', '', '## Setup', ''].join('\n');
  assert.deepEqual([...anchorsOf(text, defaultSlugify)].sort(), ['setup', 'setup-2', 'setup-3', 'top-title']);
});

test('anchors: an explicit id reserves its slug in the dedup pool', () => {
  const text = ['## One {#setup}', '', '## Setup', ''].join('\n');
  const anchors = anchorsOf(text, defaultSlugify);
  // the generated slug of the second heading dedups against the explicit id
  assert.ok(anchors.has('setup'));
  assert.ok(anchors.has('setup-2'));
});

test('the built-in resolver: missing, ambiguous, anchor and unmatched are each reported once', () => {
  const result = checkWikilinks(NOTES);
  assert.equal(result.notes, 5);
  assert.equal(result.wikilinks, 11);
  assert.deepEqual(lines(result.report).sort(), [
    'FAIL ambiguous alpha: [[shared]] → beta / gamma',
    'FAIL missing alpha: [[cards/one]]',
    'FAIL missing alpha: [[compost-heap]]',
    'WARN anchor alpha: [[beta#nope]] (no such heading in beta)',
    'WARN anchor zh/alpha: [[beta#第二节]] (no such heading in beta)',
    'WARN unmatched alpha: stray unclosed [[ near line 14',
  ]);
  assert.equal(result.fails, 3);
  assert.equal(result.warns, 3);
});

test('--allow: a listed target that resolves to nothing is INFO, not FAIL', () => {
  const result = checkWikilinks(NOTES, { allow: ['compost-heap'] });
  assert.equal(result.fails, 2);
  assert.ok(lines(result.report).includes('INFO allowed alpha: [[compost-heap]]'));
  assert.equal(lines(result.report).some((l) => l.startsWith('FAIL missing alpha: [[compost-heap]]')), false);
});

test('MDX notes: JSX children are prose, fenced code is not, and anchors resolve across files', () => {
  // beta/index.mdx links [[alpha#Deep Dive]] and [[alpha#custom-id]] from inside <Aside>; neither warns
  const { report } = checkWikilinks(NOTES);
  assert.equal(report.some((r) => r.note === 'beta'), false);
});

test('--locale-prefix: a link inside a mirror resolves to the mirror first', () => {
  // zh/alpha links [[beta#第二节]]: the heading exists in zh/beta only
  const without = checkWikilinks(NOTES).report.filter((r) => r.note === 'zh/alpha');
  assert.deepEqual(lines(without), ['WARN anchor zh/alpha: [[beta#第二节]] (no such heading in beta)']);
  const withZh = checkWikilinks(NOTES, { locales: [{ code: 'zh', prefix: 'zh/' }] });
  assert.deepEqual(
    withZh.report.filter((r) => r.note === 'zh/alpha'),
    [],
  );
});

test('--extra adds a flat corpus under an id prefix (dot and underscore entries skipped)', () => {
  const result = checkWikilinks(NOTES, { extras: [{ dir: CARDS, prefix: 'cards' }] });
  assert.equal(result.notes, 7);
  assert.equal(result.report.some((r) => r.message === '[[cards/one]]'), false);
  assert.equal(result.fails, 2);
});

test('--config: the site resolver and slugifier replace the built-in ones', async () => {
  const site = await loadSiteConfig(SITE_CONFIG);
  const result = checkWikilinks(NOTES, { site });
  const out = lines(result.report);
  // compost-heap is an alias the site resolver knows; shared is not a key there at all
  assert.equal(out.includes('FAIL missing alpha: [[compost-heap]]'), false);
  assert.ok(out.includes('FAIL missing alpha: [[shared]]'));
  // beta's heading is slugged with the site's slugifier on both sides: "Second Heading" matches, "nope" does not
  assert.ok(out.includes('WARN anchor alpha: [[beta#nope]] (no such heading in beta)'));
  assert.equal(out.some((l) => l.includes('[[beta#Second Heading]]')), false);
  // notes the site resolver does not know are missing under it
  assert.ok(out.includes('FAIL missing gamma: [[first]]'));
});

test('--config rejects a module without a wikilinks options object', async () => {
  await assert.rejects(loadSiteConfig(fileURLToPath(new URL('./fixtures/site-config-empty.mjs', import.meta.url))), /wikilinks/);
});

test('a backslash-escaped wikilink is neither a dead link nor a stray opener', () => {
  // alpha carries `\[[never-a-note]]`: an unescaped spelling would FAIL
  // missing and the leftover [[ would WARN unmatched
  const { report } = checkWikilinks(NOTES);
  assert.equal(report.some((r) => r.message.includes('never-a-note')), false);
  assert.equal(report.filter((r) => r.kind === 'unmatched').length, 1);
});

test('a trailing valued option is a usage error', async () => {
  for (const argv of [[NOTES, '--config'], [NOTES, '--allow'], ['--extra']]) {
    assert.equal(await main(argv), 2);
  }
});

test('a nonexistent content dir and an empty corpus fail; --allow-empty accepts only the latter', async () => {
  const missing = join(tmpdir(), 'inkbrush-no-such-notes');
  assert.equal(await main([missing]), 1);
  assert.equal(await main([missing, '--allow-empty']), 1);
  const empty = mkdtempSync(join(tmpdir(), 'inkbrush-nonotes-'));
  try {
    assert.equal(await main([empty]), 1);
    assert.equal(await main([empty, '--allow-empty']), 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('an extra corpus follows symlinks only inside its own tree and terminates on cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-cards-'));
  const outside = mkdtempSync(join(tmpdir(), 'inkbrush-vault-'));
  try {
    writeFileSync(join(outside, 'leak.md'), '---\ntitle: Leak\n---\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'one.md'), '---\ntitle: One\n---\n');
    writeFileSync(join(dir, 'sub', 'two.md'), '---\ntitle: Two\n---\n');
    symlinkSync(dir, join(dir, 'loop'));
    symlinkSync(outside, join(dir, 'ext'));
    symlinkSync(join(dir, 'sub'), join(dir, 'alias'));
    const corpus = collectCorpus(NOTES, [{ dir, prefix: 'cards' }]);
    const cardIds = corpus.map((n: { id: string }) => n.id).filter((id: string) => id.startsWith('cards/'));
    // each real directory is visited once, under the first path that reaches
    // it in name order: `alias` (a symlink to sub/) precedes `sub`; the
    // escaping `ext` link and the `loop` cycle contribute nothing
    assert.deepEqual(cardIds.sort(), ['cards/alias/two', 'cards/one']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
