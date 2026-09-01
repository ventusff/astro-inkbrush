/**
 * The frontmatter schema gate: issue paths, the problem lines a schema
 * yields, and the three shapes a schema module may take (a factory called
 * with Astro's zod, a plain Standard Schema export, no schema at all).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  frontmatterProblems,
  isStandardSchema,
  issuePath,
  loadFrontmatterSchema,
} from '../src/lib/frontmatter-schema.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('issue paths render as a.b[2].c; a root issue has none', () => {
  assert.equal(issuePath(undefined), '');
  assert.equal(issuePath([]), '');
  assert.equal(issuePath(['sources']), 'sources');
  assert.equal(issuePath(['sources', 2, 'title']), 'sources[2].title');
  assert.equal(issuePath([{ key: 'tags' }, { key: 0 }]), 'tags[0]');
});

test('a Standard Schema is recognised by its ~standard interface', async () => {
  const { frontmatter } = await import('./fixtures/frontmatter-schema-plain.mjs');
  assert.ok(isStandardSchema(frontmatter));
  assert.equal(isStandardSchema({}), false);
  assert.equal(isStandardSchema(null), false);
  assert.equal(isStandardSchema({ '~standard': { version: 2, validate() {} } }), false);
});

test('a factory module is called with Astro\'s zod; its findings name the field and the file line is the caller\'s', async () => {
  const schema = await loadFrontmatterSchema(fixture('frontmatter-schema.ts'));
  assert.deepEqual(await frontmatterProblems(schema, { title: 'ok', sources: [{ title: 'a' }] }), []);
  const problems = await frontmatterProblems(schema, { title: 'ok', sources: [{ title: 'a' }, { title: 'b' }, { title: 'c' }], tags: [7] });
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^frontmatter sources: /);
  assert.match(problems[1]!, /^frontmatter tags\[0\]: /);
  // an absent block is the empty mapping: the required title is missing
  assert.match((await frontmatterProblems(schema, {}))[0]!, /^frontmatter title: /);
});

test('a plain Standard Schema export is used as it is', async () => {
  const schema = await loadFrontmatterSchema(fixture('frontmatter-schema-plain.mjs'));
  assert.deepEqual(await frontmatterProblems(schema, { title: 'x' }), []);
  assert.deepEqual(await frontmatterProblems(schema, { title: 1 }), ['frontmatter title: title must be a string']);
});

test('a module without a schema, or with a non-schema export, is refused with the reason', async () => {
  await assert.rejects(loadFrontmatterSchema(fixture('frontmatter-schema-none.mjs')), /no default, "frontmatter" or "schema" export/);
  await assert.rejects(loadFrontmatterSchema(fixture('site-config-empty.mjs')), /not a Standard Schema/);
});
