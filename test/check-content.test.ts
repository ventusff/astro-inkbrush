/**
 * check-content: the frontmatter checks (YAML errors, ` #` truncation,
 * CRLF accepted), the dialect + guard compile for md and mdx, --math, the
 * site plugin module loaded through --config, and the block-stamp check —
 * over test/fixtures/content and test/fixtures/site-config*.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkContent, checkFrontmatter, globToRe, loadSiteConfig, main } from '../scripts/check-content.mjs';

const CONTENT = fileURLToPath(new URL('./fixtures/content', import.meta.url));
const SITE_CONFIG = fileURLToPath(new URL('./fixtures/site-config.ts', import.meta.url));

type Findings = Map<string, string[]>;
const byFile = (findings: { file: string; problems: string[] }[]): Findings =>
  new Map(findings.map((f) => [f.file, f.problems]));

test('globs: **, * and {a,b}', () => {
  const re = globToRe('**/index.{md,mdx}');
  assert.ok(re.test('index.md'));
  assert.ok(re.test('a/b/index.mdx'));
  assert.equal(re.test('a/b/readme.md'), false);
  assert.ok(globToRe('cards/*.md').test('cards/x.md'));
  assert.equal(globToRe('cards/*.md').test('cards/sub/x.md'), false);
});

test('frontmatter: a YAML error and ` #` truncation are findings; CRLF and quoted values are not', () => {
  assert.deepEqual(checkFrontmatter('---\r\ntitle: "ok: #1, fine"\r\n---\r\nbody'), []);
  assert.deepEqual(checkFrontmatter('no frontmatter\n---\ntitle: x # y\n---'), []);
  const truncated = checkFrontmatter('---\ntitle: deploy #3 checklist\nok: "quoted # kept"\n---');
  assert.equal(truncated.length, 1);
  assert.match(truncated[0]!, /^frontmatter line 2: .*"deploy"/);
  const invalid = checkFrontmatter('\n---\ntitle: [unclosed\n---');
  assert.equal(invalid.length, 1);
  assert.match(invalid[0]!, /^frontmatter line \d+: YAML [A-Z_]+ — /);
});

test('without --config: dialect + guard, YAML findings, docs/ skipped, CRLF accepted', async () => {
  const { checked, findings } = await checkContent(CONTENT);
  assert.equal(checked, 9);
  const f = byFile(findings);
  assert.deepEqual([...f.keys()].sort(), ['bad-yaml/index.md', 'guard/index.mdx', 'math/index.mdx', 'truncated/index.md']);
  assert.match(f.get('guard/index.mdx')![0]!, /`\*\*` is unpaired/);
  assert.match(f.get('bad-yaml/index.md')![0]!, /^frontmatter line \d+: YAML/);
  assert.equal(f.get('truncated/index.md')!.length, 2);
  // without remark-math the formula's braces are MDX expressions
  assert.match(f.get('math/index.mdx')![0]!, /closing brace/);
});

test('--math mounts remark-math: the broken formula becomes a KaTeX finding', async () => {
  const f = byFile((await checkContent(CONTENT, { math: true })).findings);
  assert.match(f.get('math/index.mdx')![0]!, /KaTeX cannot render/);
});

test('--config mounts the site plugins after the dialect, remark then rehype', async () => {
  const site = await loadSiteConfig(SITE_CONFIG);
  assert.equal(site.remarkPlugins.length, 1);
  assert.equal(site.rehypePlugins.length, 1);
  const f = byFile((await checkContent(CONTENT, { site })).findings);
  assert.deepEqual(f.get('forbidden/index.md'), ['site plugin: FORBIDDEN is not allowed']);
  assert.deepEqual(f.get('rehype/index.md'), ['site rehype plugin: headings stop at h5']);
  // the guard still runs ahead of the site plugins
  assert.match(f.get('guard/index.mdx')![0]!, /`\*\*` is unpaired/);
});

test('--glob and --skip narrow the file set', async () => {
  const only = await checkContent(CONTENT, { globs: ['good/*.md', 'crlf/index.md'] });
  assert.equal(only.checked, 2);
  assert.deepEqual(only.findings, []);
  const skipped = await checkContent(CONTENT, { skip: ['guard', 'math/'] });
  assert.equal(skipped.checked, 7);
});

test('the block map is verified: footnotes and raw HTML pass, an unreachable block is a finding', async () => {
  const clean = await checkContent(CONTENT, { globs: ['footnotes/index.md'] });
  assert.deepEqual(clean.findings, []);
  const site = await loadSiteConfig(fileURLToPath(new URL('./fixtures/site-config-unstamped.mjs', import.meta.url)));
  const f = byFile((await checkContent(CONTENT, { site, globs: ['good/index.md'] })).findings);
  assert.match(f.get('good/index.md')![0]!, /^block stamps: <div> has no source range/);
});

test('a trailing valued option is a usage error', async () => {
  for (const argv of [[CONTENT, '--config'], [CONTENT, '--glob'], ['--skip']]) {
    assert.equal(await main(argv), 2);
  }
});

test('a nonexistent root and an empty corpus fail; --allow-empty accepts only the latter', async () => {
  const missing = join(tmpdir(), 'inkbrush-no-such-root');
  assert.equal(await main([missing]), 1);
  assert.equal(await main([missing, '--allow-empty']), 1);
  const empty = mkdtempSync(join(tmpdir(), 'inkbrush-empty-'));
  try {
    assert.equal(await main([empty]), 1);
    assert.equal(await main([empty, '--allow-empty']), 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the walker follows symlinks only inside the root and terminates on cycles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-content-'));
  const outside = mkdtempSync(join(tmpdir(), 'inkbrush-elsewhere-'));
  try {
    mkdirSync(join(outside, 'leak'));
    writeFileSync(join(outside, 'leak', 'index.md'), 'text with an `**` unpaired marker\n');
    mkdirSync(join(dir, 'note'));
    writeFileSync(join(dir, 'note', 'index.md'), 'clean\n');
    symlinkSync(dir, join(dir, 'zloop'));
    symlinkSync(outside, join(dir, 'zout'));
    const { checked, findings } = await checkContent(dir);
    // the out-of-root symlink is not scanned: its bad note is neither
    // checked nor a finding, and the cycle terminates
    assert.equal(checked, 1);
    assert.deepEqual(findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a config module without plugin lists is accepted; a non-array list is rejected', async () => {
  const empty = await loadSiteConfig(fileURLToPath(new URL('./fixtures/site-config-empty.mjs', import.meta.url)));
  assert.deepEqual(empty.remarkPlugins, []);
  assert.deepEqual(empty.rehypePlugins, []);
  await assert.rejects(loadSiteConfig(fileURLToPath(new URL('./fixtures/site-config-bad.mjs', import.meta.url))), /must be an array/);
});

const FRONTMATTER = fileURLToPath(new URL('./fixtures/frontmatter', import.meta.url));
const SCHEMA = fileURLToPath(new URL('./fixtures/frontmatter-schema.ts', import.meta.url));

test('--frontmatter: every file\'s mapping must satisfy the schema; an absent block is {}; a YAML error is not doubled', async () => {
  const { loadFrontmatterSchema } = await import('../src/lib/frontmatter-schema.ts');
  const frontmatter = await loadFrontmatterSchema(SCHEMA);
  const { checked, findings } = await checkContent(FRONTMATTER, { frontmatter });
  assert.equal(checked, 4);
  const f = byFile(findings);
  assert.deepEqual([...f.keys()].sort(), ['bad-yaml/index.md', 'no-block/index.md', 'too-many/index.md']);
  assert.match(f.get('too-many/index.md')![0]!, /^frontmatter sources: /);
  assert.match(f.get('too-many/index.md')![1]!, /^frontmatter tags\[1\]: /);
  assert.match(f.get('no-block/index.md')![0]!, /^frontmatter title: /);
  // the unparseable block is one YAML finding, not a YAML finding plus a schema finding on {}
  assert.equal(f.get('bad-yaml/index.md')!.length, 1);
  assert.match(f.get('bad-yaml/index.md')![0]!, /YAML/);
  // without the schema only the YAML error remains
  assert.deepEqual([...byFile((await checkContent(FRONTMATTER)).findings).keys()], ['bad-yaml/index.md']);
});

test('--frontmatter on the CLI: findings fail the run; an unloadable schema module is a usage error', async () => {
  assert.equal(await main([FRONTMATTER, '--frontmatter', SCHEMA]), 1);
  assert.equal(await main([FRONTMATTER, '--glob', 'ok/index.md', '--frontmatter', SCHEMA]), 0);
  assert.equal(await main([FRONTMATTER, '--frontmatter', fileURLToPath(new URL('./fixtures/frontmatter-schema-none.mjs', import.meta.url))]), 2);
  assert.equal(await main([FRONTMATTER, '--frontmatter']), 2);
});
