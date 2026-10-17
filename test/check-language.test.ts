/**
 * check-language: the code-language check alone, over the source-language
 * pages of the translation declaration above the content root.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

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
    const r = await checkLanguage(join(dir, 'docs'));
    assert.equal(r.checked, 2);
    assert.deepEqual(r.files, [
      { file: 'a/index.mdx', errors: ['5:13  Chinese in the attribute `unit`: <Bars unit="个" />'], warnings: ['7:3  Chinese in inline code: `<作业号>`'] },
      { file: 'b/index.md', errors: ['2:6  Chinese in a sh code block outside its comments: echo 你好'], warnings: [] },
    ]);
    const { value: code, out } = await quietly(() => main([join(dir, 'docs')]));
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
