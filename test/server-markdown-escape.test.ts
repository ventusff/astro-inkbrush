import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitFrontmatter } from '../src/lib/frontmatter.ts';
import { escapeLinkUrl, escapeMarkdownText, yamlFrontmatter } from '../src/wiki/server/markdown-escape.ts';
import { validateSource } from '../src/wiki/server/validate.ts';

test('markdown-significant characters in metadata text are backslash-escaped', () => {
  assert.equal(escapeMarkdownText('a *b* [c]'), 'a \\*b\\* \\[c\\]');
  assert.equal(escapeMarkdownText('**unclosed _and `code'), '\\*\\*unclosed \\_and \\`code');
  assert.equal(escapeMarkdownText('$$x$$ <tag> ~~s~~ |cell|'), '\\$\\$x\\$\\$ \\<tag\\> \\~\\~s\\~\\~ \\|cell\\|');
  assert.equal(escapeMarkdownText('back\\slash'), 'back\\\\slash');
  // newlines cannot break out of the surrounding line
  assert.equal(escapeMarkdownText('line\none\t two'), 'line one two');
  assert.equal(escapeMarkdownText('plain title 标题'), 'plain title 标题');
});

test('link destinations survive parentheses, spaces and angle brackets', () => {
  assert.equal(escapeLinkUrl('https://x.example/a b(c)'), 'https://x.example/a%20b%28c%29');
  assert.equal(escapeLinkUrl('https://x.example/<y>\\z'), 'https://x.example/%3Cy%3E%5Cz');
  // existing percent-escapes pass through untouched
  assert.equal(escapeLinkUrl('https://x.example/a%20b'), 'https://x.example/a%20b');
  assert.equal(escapeLinkUrl('https://x.example/q?a=1&b=2#frag'), 'https://x.example/q?a=1&b=2#frag');
});

test('hostile titles round-trip through the frontmatter parser byte-exactly', () => {
  const hostile = [
    'He said "quote" — and: colon',
    "title: with #comment ' quotes",
    '  [brackets] & *stars* $$math$$ ]] ',
    '---',
    '中文标题：含全角符号（测试）',
  ];
  for (const title of hostile) {
    const block = yamlFrontmatter({ title, description: title, brand: 'Inbox' });
    const parsed = splitFrontmatter(`${block}\n\nbody\n`);
    assert.equal(parsed.error, null, `parse error for ${JSON.stringify(title)}`);
    assert.equal(parsed.data['title'], title);
    assert.equal(parsed.data['description'], title);
  }
});

test('an assembled attribution line with hostile metadata passes validation', async () => {
  const label = escapeMarkdownText('**Weird source** · [Autho]r');
  const url = escapeLinkUrl('https://e.example/a(b) c');
  const source = `${yamlFrontmatter({ title: 'x**y "z] $$' })}\n\n> Source: [${label}](${url}) · ${escapeMarkdownText('2026-08-*23')}\n\nbody\n`;
  assert.equal(await validateSource('inbox/x/index.md', source), null);
});
