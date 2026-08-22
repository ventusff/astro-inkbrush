/**
 * Unit tests for remarkContentGuard — the build-time gate against silent
 * content deformation.
 *
 * Wiring mirrors scripts/check-content.mjs exactly: the guard runs behind the
 * package's own dialect (GFM with singleTilde:false + the CJK-friendly
 * extensions), so anything the real parser pairs up is invisible to the guard
 * and anything it leaves in a text node is judged by the parser's own
 * flanking rules. Plain-markdown cases go through unified + remark-parse;
 * MDX-only node types (expressions, JSX attributes) go through @mdx-js/mdx.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compile } from '@mdx-js/mdx';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { remarkContentGuard, type ContentGuardOptions } from '../src/lib/content-guard.ts';
import { markdownSyntax } from '../src/lib/markdown-syntax.ts';

/** Run the guard the way check-content.mjs does for .md files. */
async function guardMd(
  body: string,
  opts: ContentGuardOptions = {},
  { math = true }: { math?: boolean } = {},
): Promise<string | null> {
  const plugins = [...markdownSyntax(), [remarkContentGuard, opts], ...(math ? [remarkMath] : [])];
  const processor = unified().use(remarkParse).use(plugins as never);
  const file = {
    value: body,
    path: 'sample.md',
    fail(reason: string): never {
      throw new Error(reason);
    },
  };
  try {
    await processor.run(processor.parse(body), file as never);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Run the guard the way check-content.mjs does for .mdx files. */
async function guardMdx(body: string, opts: ContentGuardOptions = {}): Promise<string | null> {
  const plugins = [...markdownSyntax(), [remarkContentGuard, opts], remarkMath];
  try {
    await compile(body, { remarkPlugins: plugins as never });
    return null;
  } catch (err) {
    const e = err as { reason?: string; message: string };
    return e.reason ?? e.message;
  }
}

const flagged = (report: string | null): report is string => report !== null;

/* ---------------- emphasis markers: what must pass ---------------- */

test('emphasis paired across CJK punctuation is valid, not a leak', async () => {
  // the dialect's flagship case: without the CJK extension this leaks
  assert.equal(await guardMd('前文**报文。**同时继续。'), null);
});

test('ordinary paired emphasis and strikethrough pass', async () => {
  assert.equal(await guardMd('a **bold** and _em_ and ~~gone~~ word'), null);
});

test('close-only single markers are proven literal and pass', async () => {
  assert.equal(await guardMd('距离 M87* 约五千万光年。'), null);
  assert.equal(await guardMd('A* 规划算法。'), null);
});

test('intraword underscores, spaced asterisks and escapes pass', async () => {
  assert.equal(await guardMd('use snake_case here'), null);
  assert.equal(await guardMd('compute 5 * 3 now'), null);
  assert.equal(await guardMd('a literal \\* star'), null);
});

test('a single tilde is never a marker (dialect: singleTilde off)', async () => {
  assert.equal(await guardMd('约~2 分钟，~15 件。'), null);
});

/* ---------------- emphasis markers: what must flag ---------------- */

test('an open-capable asterisk leaked into prose flags with position', async () => {
  const report = await guardMd('see *.md files for details');
  assert.ok(flagged(report));
  assert.match(report, /sample\.md:1:5/);
  assert.match(report, /`\*`/);
  assert.match(report, /\^/); // caret excerpt present
});

test('an unclosed ** flags', async () => {
  const report = await guardMd('前一行正常。\n这里**没闭合的强调。');
  assert.ok(flagged(report));
  assert.match(report, /sample\.md:2:/);
  assert.match(report, /`\*\*`/);
});

test('a close-only ~~ run still flags (double markers never belong in prose)', async () => {
  const report = await guardMd('句子结尾~~');
  assert.ok(flagged(report));
  assert.match(report, /`~~`/);
});

/* ---------------- math ---------------- */

test('single-line $$x$$ flags as inline-demoted display math', async () => {
  const report = await guardMd('$$E=mc^2$$');
  assert.ok(flagged(report));
  assert.match(report, /`\$\$`|\$\$/);
  assert.match(report, /:\d+:\d+/);
});

test('three-line display math and inline math pass', async () => {
  assert.equal(await guardMd('$$\nE=mc^2\n$$'), null);
  assert.equal(await guardMd('inline $a+b$ math'), null);
});

test('an HTML entity inside math flags', async () => {
  const report = await guardMd('bound $a &lt; b$ here');
  assert.ok(flagged(report));
  assert.match(report, /&lt;/);
});

test('a formula KaTeX cannot render flags (production renders it as red text)', async () => {
  const report = await guardMd('bad $\\notacommand{x}$ macro');
  assert.ok(flagged(report));
  assert.match(report, /:\d+:\d+/);
});

test('$$ leaked into prose flags even with math disabled', async () => {
  const report = await guardMd('formula $$x$$ here', {}, { math: false });
  assert.ok(flagged(report));
});

/* ---------------- line-wrap list markers ---------------- */

test('a + list directly under a paragraph flags as a wrapped line', async () => {
  const report = await guardMd('一句话被折行\n+ 后半句掉了下来');
  assert.ok(flagged(report));
  assert.match(report, /sample\.md:2:1/);
  assert.match(report, /`\+`/);
});

test('a - list directly under a paragraph does not flag', async () => {
  assert.equal(await guardMd('a real paragraph\n- a real list item'), null);
});

test('a + list separated by a blank line does not flag', async () => {
  assert.equal(await guardMd('a paragraph\n\n+ a deliberate list'), null);
});

/* ---------------- MDX expressions ---------------- */

test('a numeric comma expression in prose flags (MDX evaluates it away)', async () => {
  const report = await guardMdx('values {0,1,2,3} disappear');
  assert.ok(flagged(report));
  assert.match(report, /\{0,1,2,3\}/);
  assert.match(report, /:\d+:\d+/);
});

test('MDX comments and template literals are the two allowed expressions', async () => {
  assert.equal(await guardMdx('text {/* a comment */} more'), null);
  assert.equal(await guardMdx('style={`--w:${"50"}%`}\n\nplain text'), null);
});

/* ---------------- renderedProps whitelist ---------------- */

test('math in a non-whitelisted component prop flags', async () => {
  const report = await guardMdx('<Card meta="$\\alpha$-decay" />', {
    renderedProps: { Card: ['alias'] },
  });
  assert.ok(flagged(report));
  assert.match(report, /Card/);
  assert.match(report, /meta/);
});

test('math in a whitelisted prop passes', async () => {
  assert.equal(
    await guardMdx('<Card alias="$\\alpha$-decay" />', { renderedProps: { Card: ['alias'] } }),
    null,
  );
});

test('without renderedProps the attribute check is off entirely', async () => {
  assert.equal(await guardMdx('<Card meta="**raw** $x$" />'), null);
});

/* ---------------- autoNumberedHeadings ---------------- */

test('a hand-numbered heading flags only when the site auto-numbers', async () => {
  const report = await guardMd('## 1. Pillars', { autoNumberedHeadings: true });
  assert.ok(flagged(report));
  assert.match(report, /:\d+:\d+/);
  assert.equal(await guardMd('## 1. Pillars'), null);
  assert.equal(await guardMd('## Pillars', { autoNumberedHeadings: true }), null);
});

/* ---------------- reporting shape ---------------- */

test('multiple findings are all reported, sorted by position', async () => {
  const report = await guardMd('first *leak here\n\nsecond **leak here');
  assert.ok(flagged(report));
  const first = report.indexOf(':1:');
  const second = report.indexOf(':3:');
  assert.ok(first !== -1 && second !== -1 && first < second, report);
});

test('code blocks and inline code are outside the guard entirely', async () => {
  assert.equal(await guardMd('```\n*raw* {0,1} $$x$$\n```\n\nand `*inline*` too'), null);
});
