import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSiteHooks } from '../src/wiki/server/site.ts';
import { validateSource, withoutFrontmatter } from '../src/wiki/server/validate.ts';

test('frontmatter is blanked, not removed, so line numbers hold', () => {
  const out = withoutFrontmatter('---\ntitle: x\n---\n\nbody');
  assert.equal(out.split('\n').length, 5);
  assert.match(out, /^\n\n\n\nbody$/);
});

test('markdown and MDX are both validated with the dialect and the guard', async () => {
  assert.equal(await validateSource('a/index.md', '# Title\n\nfine **bold** text\n'), null);
  assert.match((await validateSource('a/index.md', 'an **unclosed marker\n')) ?? '', /\*\*/);
  assert.equal(await validateSource('a/index.mdx', '# Title\n\n<span>ok</span>\n'), null);
  assert.match((await validateSource('a/index.mdx', '<div>\n\nunclosed\n')) ?? '', /./);
});

test("the site's remark plugins run as well", async () => {
  setSiteHooks({
    remarkPlugins: [
      () => () => {
        throw new Error('site plugin refused');
      },
    ],
  });
  assert.match((await validateSource('a/index.md', 'text')) ?? '', /site plugin refused/);
  setSiteHooks(undefined);
});

test('broken frontmatter YAML fails validation with its file line', async () => {
  const problem = await validateSource('a/index.md', '---\ntitle: ok\nbad: [unclosed\n---\n\nbody\n');
  assert.match(problem ?? '', /frontmatter/);
  // the flow sequence opens on frontmatter line 2 = file line 3
  assert.match(problem ?? '', /line/);
  assert.equal(await validateSource('a/index.md', '---\ntitle: fine\n---\n\nbody\n'), null);
});

test("the site's rehype plugins run for both .md and .mdx", async () => {
  setSiteHooks({
    rehypePlugins: [
      () => () => {
        throw new Error('site rehype refused');
      },
    ],
  });
  assert.match((await validateSource('a/index.md', 'text')) ?? '', /site rehype refused/);
  assert.match((await validateSource('a/index.mdx', 'text')) ?? '', /site rehype refused/);
  setSiteHooks(undefined);
});
