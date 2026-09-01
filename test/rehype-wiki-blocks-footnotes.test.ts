/**
 * Footnote definitions render in the document's footnote section, away
 * from where they are written: the section carries no stamp and each item
 * carries its own definition's lines. A raw HTML block stands behind an
 * anchor. A positionless block never gap-fills over a footnote definition.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { VFile } from 'vfile';

import { markdownSyntax } from '../src/lib/markdown-syntax.ts';
import { rehypeWikiBlocks } from '../src/lib/rehype-wiki-blocks.ts';
import { blockStampProblems, collectStamps } from '../src/lib/wiki-blocks-check.ts';

type Tree = { children: { type: string; tagName?: string; properties?: Record<string, unknown> }[] };

async function stamped(source: string, before: unknown[] = []): Promise<Tree> {
  const p = unified()
    .use(remarkParse)
    .use(markdownSyntax())
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(before as never)
    .use(rehypeWikiBlocks);
  const file = new VFile({ value: source });
  return (await p.run(p.parse(file), file)) as unknown as Tree;
}

const stampsOf = (tree: Tree) => collectStamps(tree as never).stamps.map((s) => `${s.where} ${s.start}-${s.end}`);

test('footnote items are stamped with their own definition; the section is not', async () => {
  const src = 'Para one.[^a]\n\n[^a]: first note\n\nPara two.[^b]\n\n[^b]: second note\n  continued\n\nTail.\n';
  const tree = await stamped(src);
  assert.deepEqual(stampsOf(tree), ['<p> 1-1', '<p> 5-5', '<p> 10-10', '<li> 3-3', '<li> 7-8']);
  const section = tree.children.find((c) => c.tagName === 'section')!;
  assert.equal(section.properties?.['data-wiki-src'], undefined);
  assert.deepEqual(blockStampProblems(tree as never, src.split('\n').length), []);
});

test('a raw HTML block stands behind a data-wiki-html anchor', async () => {
  const src = 'Text.\n\n<div class="x">\nraw\n</div>\n\n<!-- note -->\n\nEnd.\n';
  const tree = await stamped(src);
  assert.deepEqual(stampsOf(tree), [
    '<p> 1-1',
    '<template data-wiki-html> 3-5',
    '<template data-wiki-html> 7-7',
    '<p> 9-9',
  ]);
  assert.deepEqual(blockStampProblems(tree as never), []);
});

test('a positionless block gap-fills up to, never over, a footnote definition', async () => {
  const src = 'Para.[^a]\n\nTail.\n\n[^a]: note\n';
  // the second paragraph loses its position, as a KaTeX display block has none
  const dropPosition = () => (tree: Tree) => {
    const ps = tree.children.filter((c) => c.tagName === 'p') as { position?: unknown }[];
    delete ps[1]!.position;
  };
  const tree = await stamped(src, [dropPosition]);
  assert.deepEqual(stampsOf(tree), ['<p> 1-1', '<p> 3-3', '<li> 5-5']);
  assert.deepEqual(blockStampProblems(tree as never), []);
});
