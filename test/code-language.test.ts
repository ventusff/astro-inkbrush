/**
 * code-language: every place the translation sync service copies — script,
 * attributes other than the reader-facing ones, inline code, code outside a
 * code block's comments — is read for Chinese; the places it translates are
 * not. code-comments: the comments each language's reader proves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { codeComments } from '../src/lib/code-comments.ts';
import { CODE_LANGUAGE_SEVERITY, codeLanguageFindings, codeLanguageSeverity, type CodeLanguageFinding } from '../src/lib/code-language.ts';
import { markdownSyntax } from '../src/lib/markdown-syntax.ts';

const parse = (source: string, mdx = true) =>
  unified()
    .use(remarkParse)
    .use(mdx ? [remarkMdx] : [])
    .use(markdownSyntax() as never)
    .use(remarkMath)
    .parse(source);

const find = (source: string, mdx = true): CodeLanguageFinding[] => codeLanguageFindings(parse(source, mdx) as never, source);
const places = (source: string, mdx = true): string[] => find(source, mdx).map((f) => `${f.place}@${f.line}:${f.column}`);

test('prose, reader-facing keys and attributes, text blocks and comments are translated: nothing to report', () => {
  const page = [
    "import Bars from '@components/Bars.astro';",
    "export const rows = [{ label: '命中率', values: [1] }, { title: `题库`, lines: ['第一行'] }];",
    '',
    '正文里的中文。',
    '',
    '<Bars title="命中率" caption={"读出头榜"} series={["甲", "乙"]} unit="items" />',
    '',
    '```text',
    '题库 → 评测程序',
    '```',
    '',
    '```sh',
    'npm run check  # 在 wiki 目录里跑',
    '```',
    '',
    '```python',
    'x = 1  # 一',
    '```',
    '',
    '## 小节 `{#section toc="小节"}`',
  ].join('\n');
  assert.deepEqual(places(page), []);
});

test('the script: everything but the strings the service translates — keys it copies, templates with an expression, tagged templates, JSX text, names, patterns and comments', () => {
  const page = [
    "export const NAMES = { 'locate-by-code': '按标签码找' };",
    'export const s = `共 ${3} 题`;',
    "export const t = { label: tag`标签` };",
    'export const el = <span>中文</span>;',
    'export const 名字 = /模式/; // 注释',
    '',
    '{"段落"}',
    '',
    '{/* 整段注释由服务翻译 */}',
  ].join('\n');
  assert.deepEqual(places(page), ['script@1:43', 'script@2:19', 'script@3:31', 'script@4:25', 'script@5:14', 'script@7:3']);
});

test('attributes: a plain or braced string under a name the service copies, character references decoded, and a whole spread', () => {
  const page = [
    '<Bars unit="毫秒" data={[{ label: "甲", note: "乙", id: "丙" }]} />',
    '',
    '<Chip {...{ title: "标题" }} />',
    '',
    '<Box tag="x" kind="&#x4e2d;" />',
  ].join('\n');
  assert.deepEqual(
    find(page).map((f) => `${f.place}@${f.line}:${f.column}:${f.name}`),
    ['attribute@1:13:unit', 'attribute@1:54:data', 'attribute@3:21:{...}', 'attribute@5:14:kind'],
  );
});

test('inline code and code: placeholders and code outside comments; a fence without a reader, an unclosed fence or an indented block is all code', () => {
  const page = [
    '跑 `runs/<运行>/` 看结果。',
    '',
    '```sh',
    'otsvlm serve --model <模型>  # 起服务',
    '```',
    '',
    '```c',
    '// 注释也是代码',
    '```',
    '',
    '    缩进的代码块',
  ].join('\n');
  assert.deepEqual(places(page, false), ['inline-code@1:10', 'code-block@4:23', 'code-block@8:4', 'code-block@11:5']);
  assert.deepEqual(places('```text\n没有收尾的文字块', false), ['code-block@2:1']);
  assert.deepEqual(places('```js\n// 没有收尾的注释', false), ['code-block@2:4']);
  assert.deepEqual(places('```js\n/* 第一行\n第二行 */\nconst s = "中文";\n```', false), ['code-block@4:12']);
});

test('each finding carries its place\'s severity, message and source line: warnings unless the site raises them', () => {
  const page = '`<作业号>`\n\n```sh\necho 好\n```';
  const [inline, block] = find(page, false);
  assert.equal(inline?.severity, 'warning');
  assert.equal(block?.severity, 'warning');
  assert.match(block?.message ?? '', /a sh code block outside its comments/);
  assert.equal(block?.text, 'echo 好');
  const raised = codeLanguageFindings(parse(page, false) as never, page, codeLanguageSeverity({ 'code-block': 'error' }));
  assert.deepEqual(raised.map((f) => f.severity), ['warning', 'error']);
  assert.deepEqual(Object.values(codeLanguageSeverity('error')), ['error', 'error', 'error', 'error']);
  assert.deepEqual(codeLanguageSeverity(undefined), CODE_LANGUAGE_SEVERITY);
  assert.throws(() => codeLanguageSeverity({ scripts: 'error' }), /the places are script, attribute, code-block, inline-code/);
  assert.throws(() => codeLanguageSeverity('fatal'), /'error', 'warning', or an object/);
  assert.throws(() => codeLanguageSeverity(new Map([['script', 'error']])), /'error', 'warning', or an object/);
  assert.throws(() => codeLanguageSeverity(['error']), /'error', 'warning', or an object/);
  assert.deepEqual(codeLanguageSeverity(Object.assign(Object.create(null), { script: 'error' })).script, 'error');
});

test('a finding is reported at its own line and column, once per line', () => {
  assert.deepEqual(places(['export const a = 1;', 'export const b = {', "  id: '甲', key: '乙',", '};'].join('\n')), ['script@3:8']);
  assert.deepEqual(places('<A b="甲" c={"乙"} />'), ['attribute@1:7', 'attribute@1:14']);
  assert.deepEqual(places(['- 一项', '', '  ```sh', '  echo ok', '  echo 甲', '  ```'].join('\n'), false), ['code-block@5:8']);
  assert.deepEqual(places('## 小节 `{#s toc="小节" data-x="甲"}`', false), ['inline-code@1:29']);
});

test('raw HTML in Markdown: attributes the service copies, script and style, an unclosed comment; text and comments are translated', () => {
  const page = [
    '<div data-x="甲" title="标题" class=乙>正文</div>',
    '',
    '<!-- 注释 -->',
    '',
    '<script>const s = "丙";</script>',
    '',
    '段落 <span aria-label="说明" data-y="&#20013;">字</span> 结束',
    '',
    '<!-- 没有收尾',
  ].join('\n');
  assert.deepEqual(
    find(page, false).map((f) => `${f.place}@${f.line}:${f.column}:${f.name ?? ''}`),
    ['attribute@1:14:data-x', 'attribute@1:34:class', 'script@5:20:', 'attribute@7:34:data-y', 'script@9:6:'],
  );
});

test('code-comments: each language reads only what its lexis proves', () => {
  const text = (code: string, lang: string) => (codeComments(code, lang) ?? []).map((c) => code.slice(c.start, c.end).trim());
  assert.deepEqual(text('const a = "// 不是注释"; // 是注释\n/* 块 */', 'ts'), ['是注释', '块']);
  assert.deepEqual(text('s = "# 不是"  # 是\n"""# 也不是"""', 'python'), ['是']);
  assert.deepEqual(text('echo "#不是" a#b # 是\n# 整行', 'bash'), ['是', '整行']);
  assert.equal(codeComments('cat <<EOF\n# 文本\nEOF', 'bash'), null);
  assert.deepEqual(text('key: "# 不是"  # 是\nblock: |\n  # 字符串', 'yaml'), ['是']);
  assert.deepEqual(text('a = 1 # 行尾不算\n# 整行算', 'toml'), ['整行算']);
  assert.deepEqual(text('#!/usr/bin/env bash\n# 说明 # shellcheck disable=SC2086\n# 说明', 'sh'), ['说明']);
  assert.equal(codeComments('// x', 'c'), null);
});
