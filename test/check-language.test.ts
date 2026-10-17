/**
 * check-language: the code-language check alone, over the source-language
 * pages of the translation declaration above the content root.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildPipeline, loadSiteConfig, main as contentMain } from '../scripts/check-content.mjs';
import { checkLanguage, main } from '../scripts/check-language.mjs';

function repo(pages: Record<string, string>, declared = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-language-'));
  mkdirSync(join(dir, '.git'));
  if (declared) {
    writeFileSync(
      join(dir, 'i18n.config.json'),
      JSON.stringify({ locales: ['zh', 'en'], units: [{ kind: 'pages', root: 'docs', file: '{id}/index.{mdx,md}', layout: 'prefix' }] }),
    );
  }
  for (const [path, text] of Object.entries(pages)) {
    mkdirSync(join(dir, 'docs', path, '..'), { recursive: true });
    writeFileSync(join(dir, 'docs', path), text);
  }
  return dir;
}

async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    return { value: await run(), out: lines.join('\n') };
  } finally {
    console.log = log;
  }
}

test('errors and warnings of the source pages; frontmatter keeps its lines; md pages read without MDX', async () => {
  const dir = repo({
    'a/index.mdx': '---\ntitle: 标题\n---\n\n<Bars unit="个" />\n\n`<作业号>`\n',
    'b/index.md': '```sh\necho 你好\n```\n',
    'en/a/index.mdx': '<Bars unit="个" />\n',
  });
  try {
    const quiet = await checkLanguage(join(dir, 'docs'));
    assert.deepEqual(quiet.files.map((f) => [f.file, f.errors.length, f.warnings.length]), [['a/index.mdx', 0, 2], ['b/index.md', 0, 1]]);
    const config = join(dir, 'raise.mjs');
    writeFileSync(config, "export const codeLanguage = { attribute: 'error', 'code-block': 'error' };\n");
    const site = await loadSiteConfig(config);
    const r = await checkLanguage(join(dir, 'docs'), { site });
    assert.equal(r.checked, 2);
    assert.deepEqual(r.files, [
      { file: 'a/index.mdx', errors: ['5:13  Chinese in the attribute `unit`: <Bars unit="个" />'], warnings: ['7:3  Chinese in inline code: `<作业号>`'] },
      { file: 'b/index.md', errors: ['2:6  Chinese in a sh code block outside its comments: echo 你好'], warnings: [] },
    ]);
    const { value: code, out } = await quietly(() => main([join(dir, 'docs'), '--config', config]));
    assert.equal(code, 1);
    assert.match(out, /✗ 2 errors and 1 warning:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warnings alone pass; a repository without a declaration has nothing to check; a missing root is a usage error', async () => {
  const warned = repo({ 'a/index.mdx': '`<作业号>`\n' });
  const plain = repo({ 'a/index.mdx': '```sh\necho 你好\n```\n' }, false);
  try {
    const w = await quietly(() => main([join(warned, 'docs')]));
    assert.equal(w.value, 0);
    assert.match(w.out, /✓ no errors; 1 warning \(1 source page;/);
    const p = await quietly(() => main([join(plain, 'docs')]));
    assert.equal(p.value, 0);
    assert.match(p.out, /no i18n\.config\.json/);
    const missing = await quietly(() => main([join(plain, 'nowhere')]));
    assert.equal(missing.value, 2);
  } finally {
    rmSync(warned, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('without a codeLanguage export every place is a warning and both CLIs pass; an unknown value is a usage error', async () => {
  const dir = repo({ 'a/index.mdx': "export const s = { id: '甲' };\n\n<Bars unit=\"个\" />\n\n`<作业号>`\n\n```sh\necho 你好\n```\n" });
  try {
    const plain = join(dir, 'plain.mjs');
    writeFileSync(plain, 'export const remarkPlugins = [];\n');
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, "export const codeLanguage = { scripts: 'error' };\n");
    const language = await quietly(() => main([join(dir, 'docs'), '--config', plain]));
    assert.equal(language.value, 0);
    assert.match(language.out, /✓ no errors; 4 warnings/);
    const content = await quietly(() => contentMain([join(dir, 'docs'), '--config', plain]));
    assert.equal(content.value, 0);
    const pipeline = buildPipeline({ codeLanguage: true, site: await loadSiteConfig(plain) });
    assert.equal(pipeline.remarkPlugins.length > 0, true);
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    try {
      assert.equal((await quietly(() => main([join(dir, 'docs'), '--config', bad]))).value, 2);
      assert.equal((await quietly(() => contentMain([join(dir, 'docs'), '--config', bad]))).value, 2);
    } finally {
      console.error = error;
    }
    assert.match(errors.join('\n'), /codeLanguage\.scripts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
