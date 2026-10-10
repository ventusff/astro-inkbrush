import assert from 'node:assert/strict';
import { test } from 'node:test';

import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';

import remarkMath from 'remark-math';
import remarkMdx from 'remark-mdx';

import { markdownSyntax } from '../src/lib/markdown-syntax.ts';
import { extractMentions } from '../src/lib/mention-index.ts';
import { mentionMatches, remarkMentions } from '../src/lib/mentions.ts';
import { peopleIndex, peopleOf } from '../src/lib/people.ts';

const members = [
  { email: 'Jane.Doe@team.com', name: 'Jane Doe', aliases: ['jane@home.org'] },
  { email: 'bob@team.com', name: 'bob' },
  { email: 'sam@team.com', name: '  ' },
  { email: 'sam@lab.org', name: 'Sam Lab' },
];

test('handles are email local parts; a later member whose local part is taken adds the domain label', () => {
  assert.deepEqual(peopleOf(members).map((p) => p.handle), ['jane.doe', 'bob', 'sam', 'sam.lab']);
  assert.equal(peopleOf(members)[2]!.name, 'sam');
  assert.deepEqual(
    peopleOf([...members, { email: 'sam@lab.net', name: 'Sam Net' }, { email: 'sam@lab.io', name: 'Sam Io' }]).map((p) => p.handle).slice(2),
    ['sam', 'sam.lab', 'sam.lab2', 'sam.lab3'],
  );
});

test('identify finds a member by own email or other address, else by handle; a name only where no real address speaks', () => {
  const idx = peopleIndex(members);
  assert.equal(idx.identify({ email: 'JANE@home.org' })?.handle, 'jane.doe');
  assert.equal(idx.identify({ email: 'wiki@local', name: 'jane.doe' })?.name, 'Jane Doe');
  assert.equal(idx.identify({ name: 'jane doe' })?.handle, 'jane.doe');
  assert.equal(idx.identify({ handle: '@Bob' })?.email, 'bob@team.com');
  assert.equal(idx.identify({ email: 'stranger@x.org', name: 'Stranger' }), undefined);
  assert.equal(idx.identify({ email: 'outsider@x.com', name: 'Jane Doe' }), undefined);
  assert.equal(idx.identify({ email: 'outsider@x.com', name: 'jane.doe' }), undefined);
  assert.equal(idx.member('jane@home.org'), undefined);
  assert.equal(idx.member('jane.doe@team.com')?.handle, 'jane.doe');
});

test('a handle is reduced to the mention grammar, and a kept one is used as it is', () => {
  assert.deepEqual(peopleOf([{ email: 'Jane+Wiki@x.com', name: 'J' }, { email: '..x__@y.com', name: 'X' }]).map((p) => p.handle), ['jane-wiki', 'x']);
  assert.deepEqual(peopleOf([{ email: 'a@x.com', name: 'A', handle: 'boss' }, { email: 'boss@x.com', name: 'B' }]).map((p) => p.handle), ['boss', 'boss.x']);
});

test('the grammar: addresses, scopes, paths and trailing punctuation are not mentions', () => {
  const handles = (s: string) => mentionMatches(s, null, undefined).map((m) => m.handle);
  assert.deepEqual(handles('ask @jane.doe.'), ['jane.doe']);
  assert.deepEqual(handles('请@Jane.Doe看一下,(@bob)'), ['jane.doe', 'bob']);
  assert.deepEqual(handles('mail jane@team.com or pkg/@scope or a-@b'), []);
  assert.deepEqual(handles('@jane@team.com @jane.doe@team.com @bob_ @bob.x_'), []);
  assert.deepEqual(handles('@jane.doe-x and @bob- or @bob.'), ['jane.doe-x', 'bob', 'bob']);
  assert.deepEqual(handles('[[a @jane.doe page]] @bob'), ['bob']);
});

const render = (md: string, resolve = (h: string) => (h === 'jane.doe' ? { name: 'Jane Doe', url: '/people/jane.doe/' } : undefined)) =>
  String(unified().use(remarkParse).use(remarkMentions, { resolve }).use(remarkRehype).use(rehypeStringify).processSync(md));

test('a resolved mention renders as a link to the member showing their name; the rest stays text', () => {
  assert.equal(
    render('thanks @jane.doe and @nobody'),
    '<p>thanks <a href="/people/jane.doe/" class="mention" data-mention="jane.doe">Jane Doe</a> and @nobody</p>',
  );
});

test('code, links and an escaped \\@ are left alone', () => {
  assert.equal(render('`@jane.doe` [@jane.doe](/x) \\@jane.doe'), '<p><code>@jane.doe</code> <a href="/x">@jane.doe</a> @jane.doe</p>');
  assert.equal(render('```\n@jane.doe\n```'), '<pre><code>@jane.doe\n</code></pre>');
});

/** the handles a page renders as mentions, through the page's parser (every handle resolves) */
function rendered(source: string, mdx = false): string[] {
  const out: string[] = [];
  const collect = () => (tree: { type: string; children?: unknown[]; data?: { hProperties?: Record<string, unknown> } }) => {
    const walk = (n: typeof tree): void => {
      const handle = n.data?.hProperties?.['data-mention'];
      if (typeof handle === 'string') out.push(handle);
      for (const c of (n.children ?? []) as (typeof tree)[]) walk(c);
    };
    walk(tree);
  };
  const proc = unified()
    .use(remarkParse)
    .use(markdownSyntax())
    .use(remarkMath)
    .use(mdx ? [remarkMdx] : [])
    .use(remarkMentions, { resolve: (h: string) => ({ name: h, url: `/p/${h}/` }) })
    .use(collect);
  proc.runSync(proc.parse(source), source);
  return [...new Set(out)].sort();
}

test('the index counts a mention exactly where the page renders one', () => {
  const cases: [string, boolean][] = [
    ['hi @jane.doe\n```\n@bob\n```\n`@sam` and \\@bob and @Sam.', false],
    ['[@link](u) ![@alt](a.png) [ref][@x]\n\n[@x]: http://e\n\n    @indented\n\n$@math$ <!-- @comment --> @shown', false],
    ['| a | @cell |\n|---|---|\n| @row | x |\n\n> quoted @quote', false],
    ['<Callout title="@attr">inside @child</Callout>\n\n{"@expr"} @prose', true],
    ['---\ntitle: "@front"\n---\n\n@body [[note|@wl]]', false],
  ];
  for (const [src, mdx] of cases) {
    assert.deepEqual([...extractMentions(src, { mdx })].sort(), rendered(src.replace(/^---\n[\s\S]*?\n---\n/, ''), mdx), src);
  }
  assert.deepEqual([...extractMentions(cases[1]![0])], ['shown']);
  assert.deepEqual([...extractMentions(cases[3]![0], { mdx: true })].sort(), ['child', 'prose']);
});
