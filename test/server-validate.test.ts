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
