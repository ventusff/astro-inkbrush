/**
 * Wikilink recognition is one reading in every entry point: the
 * browser-safe core alone and the full module read a character reference
 * and an escaped opener alike, with the same processor, in either order
 * of loading.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { remarkWikilinks } from '../src/lib/wikilink-core.ts';

const source = 'a &amp; \\[[Note]] and &#91;[Note]] and [[Note]]\n';

function render(): { links: number; text: string } {
  const tree = unified().use(remarkParse).parse(source) as never;
  remarkWikilinks({ resolve: () => ({ kind: 'ok', id: 'note', url: '/note/', title: 'Note' }) })(tree, { value: source });
  let links = 0;
  let text = '';
  const walk = (n: { type: string; value?: string; children?: unknown[] }): void => {
    if (n.type === 'link') links += 1;
    if (n.type === 'text') text += n.value ?? '';
    (n.children as { type: string; value?: string; children?: unknown[] }[] | undefined)?.forEach(walk);
  };
  walk(tree);
  return { links, text };
}

test('the core alone and the full module read a reference and an escape alike', async () => {
  const coreOnly = render();
  const full = await import('../src/lib/wikilinks.ts');
  assert.equal(full.remarkWikilinks, remarkWikilinks);
  assert.deepEqual(render(), coreOnly);
  // the escaped opener after a named reference is literal; the opener spelled
  // as a numeric reference is an opener: two links, the escaped spelling kept
  assert.equal(coreOnly.links, 2);
  assert.ok(coreOnly.text.includes('[[Note]]'));
});
