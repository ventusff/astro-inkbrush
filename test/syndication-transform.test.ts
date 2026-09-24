import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitFrontmatter } from '../src/lib/frontmatter.ts';
import type { Bundle } from '../src/lib/syndication-bundle.ts';
import { transformUnit, type PeerNoteInfo, type TransformInput } from '../src/lib/syndication-transform.ts';
import { findWikilinks, type WikiNoteInfo } from '../src/lib/wikilink-core.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const files = (entries: Record<string, string>): Bundle => new Map(Object.entries(entries).map(([p, t]) => [p, enc(t)]));
const locales = [{ prefix: '' }, { prefix: 'en/' }, { prefix: 'de/' }];

const note = (id: string, title: string, extra: Partial<WikiNoteInfo> = {}): WikiNoteInfo => ({ id, title, aliases: [], ...extra });
const peerNote = (id: string, title: string, origin: string | null, extra: Partial<WikiNoteInfo> = {}): PeerNoteInfo => ({
  ...note(id, title, extra),
  origin,
});

function input(overrides: Partial<TransformInput>): TransformInput {
  return {
    unit: 'chasing',
    files: files({}),
    peer: { id: 'chaser', map: {} },
    locales,
    peerLocales: locales,
    originNotes: [],
    urlForOrigin: (id) => `/wiki/${id}/`,
    peerNotes: [],
    originName: 'vortex',
    ...overrides,
  };
}

function okResult(overrides: Partial<TransformInput>) {
  const result = transformUnit(input(overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<ReturnType<typeof transformUnit>, { ok: true }>;
}

test('the value map rewrites scalars and lists (nulls drop, duplicates fold); overrides replace; syndication never travels', () => {
  const root = '---\ntitle: C\nkind: essay\ndomains: [ai, infra, ml]\ntags: [x]\nsyndication:\n  chaser:\n    status: mirrored\n    tags: null\n  other:\n    kind: z\n---\n\nbody\n';
  const result = okResult({
    files: files({ 'chasing/index.mdx': root, 'chasing/demo.ts': 'export default 1;\n' }),
    peer: { id: 'chaser', map: { kind: { essay: 'article' }, domains: { ai: 'llm', ml: 'llm', infra: null } } },
  });
  const copy = dec(result.bundle.get('chasing/index.mdx')!);
  assert.equal(copy, '---\ntitle: C\nkind: article\ndomains: [llm]\nstatus: mirrored\n---\n\nbody\n');
  assert.deepEqual(result.notes, [{ id: 'chasing', title: 'C', fields: { title: 'C', kind: 'article', domains: ['llm'], status: 'mirrored' } }]);
  assert.equal(dec(result.bundle.get('chasing/demo.ts')!), 'export default 1;\n');
  assert.match(result.digest, /^[0-9a-f]{16}$/);
});

test('a note with nothing to change passes byte-identical', () => {
  const root = '---\ntitle: C\nkind: essay\n---\n\nplain body, no links\n';
  const result = okResult({ files: files({ 'chasing/index.mdx': root }), peer: { id: 'chaser', map: { kind: { note: 'x' } } } });
  assert.equal(dec(result.bundle.get('chasing/index.mdx')!), root);
});

test('refusals: syndication false, a copy, unreadable or missing frontmatter, a missing root', () => {
  const refused = (entries: Record<string, string>) => {
    const result = transformUnit(input({ files: files(entries) }));
    assert.equal(result.ok, false);
    return (result as { refusals: unknown[] }).refusals;
  };
  assert.deepEqual(refused({ 'chasing/index.md': '---\ntitle: C\n---\n', 'chasing/sub/index.md': '---\ntitle: S\nsyndication: false\n---\n' }), [
    { code: 'never', note: 'chasing/sub' },
  ]);
  assert.deepEqual(refused({ 'chasing/index.md': '---\ntitle: C\norigin:\n  wiki: other\n  revision: aaaaaaaaaaaaaaaa\n  synced: x\n---\n' }), [
    { code: 'copy', note: 'chasing' },
  ]);
  assert.deepEqual(refused({ 'chasing/index.md': 'no block\n' }), [{ code: 'no-frontmatter', note: 'chasing' }]);
  const broken = refused({ 'chasing/index.md': '---\nbad: [\n---\n' });
  assert.equal(broken.length, 1);
  assert.equal((broken[0] as { code: string }).code, 'frontmatter');
  assert.deepEqual(refused({ 'en/chasing/index.md': '---\ntitle: C\n---\n' }), [{ code: 'no-root', note: 'chasing' }]);
});

test('wikilinks: kept when the peer resolves them the same, rewritten to the id when not, degraded when the peer will not have the note', () => {
  const body = [
    'in-unit [[chasing/attention]] and by title [[Attention]] and [[Attention#Heads|heads]]',
    'our copy elsewhere [[Elsewhere]], a foreign copy [[Foreign]], a native peer note [[Native]]',
    'a missing note [[Nowhere]] and a *label* [[Nowhere|plain #tag]] and [[Nowhere|**bold**]] is no wikilink',
    'escaped \\[[Nowhere]] stays; `code [[Nowhere]]` stays',
  ].join('\n');
  const result = okResult({
    files: files({
      'chasing/index.mdx': `---\ntitle: Chasing\n---\n\n${body}\n`,
      'chasing/attention/index.mdx': '---\ntitle: Attention\n---\n\nsub\n',
    }),
    originNotes: [
      note('chasing', 'Chasing'),
      note('chasing/attention', 'Attention'),
      note('elsewhere', 'Elsewhere'),
      note('foreign', 'Foreign'),
      note('native', 'Native'),
    ],
    peerNotes: [
      peerNote('elsewhere', 'Elsewhere', 'vortex'),
      peerNote('foreign', 'Foreign', 'someone-else'),
      peerNote('native', 'Native', null),
      // the peer has its own note titled Attention: a title link would be ambiguous there
      peerNote('peer-attention', 'Attention', null),
      // a stale sub-page of an earlier copy: gone after this publish
      peerNote('chasing/old', 'Old', 'vortex'),
    ],
  });
  const copy = dec(result.bundle.get('chasing/index.mdx')!);
  assert.equal(
    copy,
    [
      '---\ntitle: Chasing\n---\n',
      'in-unit [[chasing/attention]] and by title [[chasing/attention|Attention]] and [[chasing/attention#Heads|heads]]',
      'our copy elsewhere [[Elsewhere]], a foreign copy Foreign, a native peer note Native',
      'a missing note Nowhere and a *label* plain #tag and [[Nowhere|**bold**]] is no wikilink',
      'escaped \\[[Nowhere]] stays; `code [[Nowhere]]` stays',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.degraded, [
    { note: 'chasing', target: 'Foreign', shown: 'Foreign' },
    { note: 'chasing', target: 'Native', shown: 'Native' },
    { note: 'chasing', target: 'Nowhere', shown: 'Nowhere' },
    { note: 'chasing', target: 'Nowhere', shown: 'plain #tag' },
  ]);
});

test('locale mirrors: a link the origin resolves through its mirror is spelled out when the peer would not', () => {
  const result = okResult({
    files: files({
      'chasing/index.mdx': '---\ntitle: C\n---\n\n[[chasing/attention]]\n',
      'chasing/attention/index.mdx': '---\ntitle: A\n---\n\nx\n',
      'en/chasing/index.mdx': '---\ntitle: C (en)\n---\n\n[[chasing/attention]] and [[A]]\n',
    }),
    originNotes: [note('chasing', 'C'), note('chasing/attention', 'A'), note('en/chasing', 'C (en)'), note('en/chasing/attention', 'A (en)')],
    // the peer's en/chasing/attention is gone after this publish (not in the bundle),
    // and the peer has a note of its own titled A
    peerNotes: [peerNote('en/chasing/attention', 'A (en)', 'vortex'), peerNote('peer-a', 'A', null)],
  });
  // origin: [[chasing/attention]] from en/chasing → en/chasing/attention (mirror), which the copy
  // lacks → degrade; [[A]] is unambiguous here and ambiguous on the peer → the explicit id
  assert.equal(dec(result.bundle.get('en/chasing/index.mdx')!), '---\ntitle: C (en)\n---\n\nchasing/attention and [[chasing/attention|A]]\n');
  assert.equal(dec(result.bundle.get('chasing/index.mdx')!), '---\ntitle: C\n---\n\n[[chasing/attention]]\n');
});

test('root-relative links: Markdown links to absent notes become their text, images and JSX attributes are reported', () => {
  const body = [
    'see [the **other** note](/wiki/other/ "t") and [kept](/wiki/elsewhere/#part) and [outside](/about/)',
    '![fig](/wiki/other/fig.png)',
    '<a href="/wiki/other/">x</a> <Demo src="/wiki/other/demo.ts" />',
  ].join('\n');
  const result = okResult({
    files: files({ 'chasing/index.mdx': `---\ntitle: C\n---\n\n${body}\n` }),
    originNotes: [note('chasing', 'C'), note('other', 'Other'), note('other/deeper', 'Deeper'), note('elsewhere', 'E')],
    peerNotes: [peerNote('elsewhere', 'E', 'vortex')],
  });
  const copy = dec(result.bundle.get('chasing/index.mdx')!);
  assert.ok(copy.includes('see the **other** note and [kept](/wiki/elsewhere/#part) and [outside](/about/)'));
  assert.ok(copy.includes('![fig](/wiki/other/fig.png)'));
  assert.deepEqual(result.degraded, [{ note: 'chasing', target: '/wiki/other/', shown: 'the **other** note' }]);
  assert.deepEqual(result.warnings, [
    { note: 'chasing', url: '/wiki/other/fig.png', kind: 'image' },
    { note: 'chasing', url: '/wiki/other/', kind: 'element' },
    { note: 'chasing', url: '/wiki/other/demo.ts', kind: 'element' },
  ]);
});

test('the transform is deterministic: same inputs, same bytes, same digest', () => {
  const entries = {
    'chasing/index.mdx': '---\ntitle: C\ndomains: [ai]\n---\n\n[[Nowhere]] and [[chasing/sub]]\n',
    'chasing/sub/index.mdx': '---\ntitle: S\n---\n\n[[C]]\n',
    'chasing/a.bin': '\u0000\u0001binary',
  };
  const opts: Partial<TransformInput> = {
    files: files(entries),
    peer: { id: 'chaser', map: { domains: { ai: 'llm' } } },
    originNotes: [note('chasing', 'C'), note('chasing/sub', 'S')],
  };
  const a = okResult(opts);
  const b = okResult({ ...opts, files: files(Object.fromEntries(Object.entries(entries).reverse())) });
  assert.equal(a.digest, b.digest);
  assert.deepEqual([...a.bundle.keys()], [...b.bundle.keys()]);
  for (const [path, bytes] of a.bundle) assert.deepEqual(bytes, b.bundle.get(path));
  assert.deepEqual(splitFrontmatter(dec(a.bundle.get('chasing/index.mdx')!)).data, { title: 'C', domains: ['llm'] });
});

/* ---------------- what the copy renders as ---------------- */

import { buildRenderProcessor } from '../src/lib/render-pipeline.ts';
import { validateNoteSource } from '../src/lib/render-pipeline.ts';
import { parseSourceTree } from '../src/lib/wikilinks.ts';

/** the body of a transformed root note, with its frontmatter stripped */
function bodyOf(entries: Record<string, string>, extra: Partial<TransformInput> = {}): string {
  const result = okResult({ files: files(entries), ...extra });
  const path = Object.keys(entries).find((p) => p.startsWith('chasing/index.'))!;
  return dec(result.bundle.get(path)!).replace(/^---\n[^]*?\n---\n/, '');
}

/** rendered HTML of a Markdown body through the dialect's own pipeline */
async function html(body: string): Promise<string> {
  const processor = await buildRenderProcessor({ sanitize: false, site: {} });
  return String(await processor.process(body));
}

const textOf = (markup: string): string =>
  markup.replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16))).trim();

test('degraded text is inert wherever it lands: no block opens, no inline syntax starts', async () => {
  const labels = [
    '- item',
    '+ item',
    '* item',
    '1. item',
    '2) item',
    '# heading',
    '> quote',
    '---',
    '***',
    '===',
    '```',
    '~~~',
    '| a | b |',
    // (emphasis, math, HTML and autolinks split the text node before the wikilink transform sees it: no wikilink)
    '{expr} a&b $x',
  ];
  for (const label of labels) {
    const body = bodyOf({ 'chasing/index.md': `---\ntitle: C\n---\n\n[[Nowhere|${label}]]\n\nnext paragraph\n` });
    const rendered = await html(body);
    assert.equal(textOf(rendered.split('\n')[0] ?? rendered), label, `label ${JSON.stringify(label)} → ${body.split('\n')[0]}`);
    assert.doesNotMatch(rendered, /<(ul|ol|h[1-6]|blockquote|hr|pre|table|em|strong|code|a |del)/, `label ${JSON.stringify(label)} rendered ${rendered}`);
  }
  // inside a list item, a degraded ordered-list label must not open a nested list
  const nested = await html(bodyOf({ 'chasing/index.md': '---\ntitle: C\n---\n\n- [[Nowhere|1. item]]\n' }));
  assert.equal((nested.match(/<ol|<ul/g) ?? []).length, 1);
  assert.ok(nested.includes('1. item'));
});

test('degraded text at a paragraph start in MDX never becomes ESM', async () => {
  for (const label of ['export const demo = console.log("side effect")', 'import guide']) {
    const body = bodyOf({ 'chasing/index.mdx': `---\ntitle: C\n---\n\n[[Nowhere|${label}]]\n\ntext\n` });
    assert.equal(await validateNoteSource(body, { site: {}, mdx: true }), null, body);
    const tree = parseSourceTree(body, { mdx: true });
    assert.equal(tree.children?.[0]?.type, 'paragraph', body);
    assert.equal(tree.children?.some((n) => n.type === 'mdxjsEsm'), false, body);
  }
  // a degraded Markdown link keeps its inline formatting but cannot open a block or ESM
  const body = bodyOf(
    { 'chasing/index.mdx': '---\ntitle: C\n---\n\n[# not a **heading**](/wiki/other/)\n\n[export const x = 1](/wiki/other/)\n' },
    { originNotes: [note('chasing', 'C'), note('other', 'Other')] },
  );
  assert.equal(await validateNoteSource(body, { site: {}, mdx: true }), null, body);
  const tree = parseSourceTree(body, { mdx: true });
  assert.deepEqual(tree.children?.map((n) => n.type), ['paragraph', 'paragraph']);
  assert.ok(body.includes('**heading**'));
});

test('a rewritten id is kept only when the peer resolves that spelling to the same note (locale mirrors shadow bare ids)', () => {
  const result = okResult({
    files: files({
      'chasing/index.mdx': '---\ntitle: C\n---\n\nx\n',
      'chasing/sub/index.mdx': '---\ntitle: A\n---\n\nx\n',
      'en/chasing/index.mdx': '---\ntitle: C (en)\n---\n\n[[A#Part|read]]\n',
      'en/chasing/sub/index.mdx': '---\ntitle: Translated\n---\n\nx\n',
    }),
    originNotes: [note('chasing', 'C'), note('chasing/sub', 'A'), note('en/chasing', 'C (en)'), note('en/chasing/sub', 'Translated')],
    // the peer has a note of its own titled A: the title is ambiguous there, and the bare id
    // chasing/sub is shadowed by the mirror en/chasing/sub from an en note
    peerNotes: [peerNote('peer-a', 'A', null)],
  });
  const en = dec(result.bundle.get('en/chasing/index.mdx')!);
  assert.ok(!en.includes('[[chasing/sub#Part|read]]'), en);
  assert.ok(en.includes('read'), en);
  assert.deepEqual(result.degraded, [{ note: 'en/chasing', target: 'A#Part', shown: 'read' }]);
});

test('reference-style links and images follow their definitions', () => {
  const body = ['[go][ref], [collapsed][] and [shortcut] and [kept][k]', '', '![figure][ref]', '', '[ref]: /wiki/other/', '[collapsed]: /wiki/other/#x', '[shortcut]: /wiki/other/deeper/', '[k]: /wiki/elsewhere/'].join('\n');
  const result = okResult({
    files: files({ 'chasing/index.md': `---\ntitle: C\n---\n\n${body}\n` }),
    originNotes: [note('chasing', 'C'), note('other', 'Other'), note('other/deeper', 'Deeper'), note('elsewhere', 'E')],
    peerNotes: [peerNote('elsewhere', 'E', 'vortex')],
  });
  const copy = dec(result.bundle.get('chasing/index.md')!);
  assert.ok(copy.includes('go, collapsed and shortcut and [kept][k]'), copy);
  assert.ok(copy.includes('![figure][ref]'), copy);
  assert.deepEqual(result.degraded, [
    { note: 'chasing', target: '/wiki/other/', shown: 'go' },
    { note: 'chasing', target: '/wiki/other/#x', shown: 'collapsed' },
    { note: 'chasing', target: '/wiki/other/deeper/', shown: 'shortcut' },
  ]);
  assert.deepEqual(result.warnings, [{ note: 'chasing', url: '/wiki/other/', kind: 'image' }]);
});

test('wikilink targets and labels are read as the renderer reads them: references and escapes decoded, escaped once when degraded', () => {
  const result = okResult({
    files: files({
      'chasing/index.md': '---\ntitle: C\n---\n\n[[A&amp;B]] and [[chasing/sub|a\\*b]] and [[Nowhere|a\\*b &amp; c]] and [[Nowhere|x&#93;y]]\n',
      'chasing/sub/index.md': '---\ntitle: A&B\n---\n\nx\n',
    }),
    originNotes: [note('chasing', 'C'), note('chasing/sub', 'A&B')],
  });
  const copy = dec(result.bundle.get('chasing/index.md')!);
  assert.ok(copy.includes('[[A&amp;B]] and [[chasing/sub|a\\*b]]'), copy);
  // `x]y` is no wikilink label once decoded: the renderer leaves it, so does the copy
  assert.ok(copy.includes('and a\\*b \\& c and [[Nowhere|x&#93;y]]'), copy);
  assert.deepEqual(result.degraded, [{ note: 'chasing', target: 'Nowhere', shown: 'a*b & c' }]);
});

test('an override that leaves a field at its value schedules no edit (an anchored value keeps its anchor)', () => {
  const root = '---\ntitle: &title C\nlabel: *title\nsyndication:\n  chaser:\n    title: C\n---\n\nbody\n';
  const result = okResult({ files: files({ 'chasing/index.md': root }) });
  assert.equal(dec(result.bundle.get('chasing/index.md')!), '---\ntitle: &title C\nlabel: *title\n---\n\nbody\n');
});

/* ---------------- the copy's tree equals the original's, degraded links as text ---------------- */

function refusedWith(entries: Record<string, string>, extra: Partial<TransformInput> = {}) {
  const result = transformUnit(input({ files: files(entries), ...extra }));
  assert.equal(result.ok, false, 'expected a refusal');
  return (result as { refusals: Array<Record<string, unknown>> }).refusals;
}

test('a degrade that would change the structure around it refuses the unit instead of guessing', () => {
  assert.deepEqual(
    refusedWith({ 'chasing/index.mdx': '---\ntitle: C\n---\n\nex[[Missing|port const sideEffect = console.log("executed")]]\n' }),
    [{ code: 'degrade', note: 'chasing', target: 'Missing' }],
  );
  assert.deepEqual(refusedWith({ 'chasing/index.md': '---\ntitle: C\n---\n\n1[[Missing|. item]]\n' }), [{ code: 'degrade', note: 'chasing', target: 'Missing' }]);
  assert.deepEqual(
    refusedWith(
      { 'chasing/index.md': '---\ntitle: C\n---\n\n1[. item](/wiki/other/)\n' },
      { originNotes: [note('chasing', 'C'), note('other', 'Other')] },
    ),
    [{ code: 'degrade', note: 'chasing', target: '/wiki/other/' }],
  );
});

test('a degraded Markdown link keeps its inline formatting, wherever the formatting sits', async () => {
  const body = bodyOf(
    { 'chasing/index.md': '---\ntitle: C\n---\n\n[**bold** and `code`](/wiki/other/) then [~~gone~~](/wiki/other/)\n' },
    { originNotes: [note('chasing', 'C'), note('other', 'Other')] },
  );
  assert.equal(body, '\n**bold** and `code` then ~~gone~~\n');
  const rendered = await html(body);
  assert.match(rendered, /<strong>bold<\/strong> and <code>code<\/code> then <del>gone<\/del>/);
});

test('wikilinks are found as the renderer finds them: decoded text, delimiters and openers from references, escapes honoured', () => {
  const entries = {
    'chasing/index.md': [
      '---\ntitle: C\n---\n',
      'kept: [[Other&vert;read]] and [[Other&#35;Part|read]] and [[chasing/other&#124;shown]]',
      'gone: [[Missing&#124;read]] and &#91;[Missing]] and \\[[Missing]] stays literal',
      '',
    ].join('\n'),
    'chasing/other/index.md': '---\ntitle: Other\n---\n\nx\n',
  };
  const result = okResult({ files: files(entries), originNotes: [note('chasing', 'C'), note('chasing/other', 'Other')] });
  const copy = dec(result.bundle.get('chasing/index.md')!);
  assert.ok(copy.includes('kept: [[Other&vert;read]] and [[Other&#35;Part|read]] and [[chasing/other&#124;shown]]'), copy);
  assert.ok(copy.includes('gone: read and Missing and \\[[Missing]] stays literal'), copy);
  assert.deepEqual(result.degraded, [
    { note: 'chasing', target: 'Missing', shown: 'read' },
    { note: 'chasing', target: 'Missing', shown: 'Missing' },
  ]);
});

test('reference definitions: the first definition of an identifier wins, as the renderer renders it', () => {
  const go = (order: [string, string]) =>
    okResult({
      files: files({ 'chasing/index.md': `---\ntitle: C\n---\n\n[go][r] and ![fig][r]\n\n${order[0]}\n${order[1]}\n` }),
      originNotes: [note('chasing', 'C'), note('other', 'Other')],
    });
  const localFirst = go(['[r]: /wiki/other/', '[r]: https://example.org/']);
  assert.deepEqual(localFirst.degraded, [{ note: 'chasing', target: '/wiki/other/', shown: 'go' }]);
  assert.deepEqual(localFirst.warnings, [{ note: 'chasing', url: '/wiki/other/', kind: 'image' }]);
  const externalFirst = go(['[r]: https://example.org/', '[r]: /wiki/other/']);
  assert.deepEqual(externalFirst.degraded, []);
  assert.deepEqual(externalFirst.warnings, []);
  assert.ok(dec(externalFirst.bundle.get('chasing/index.md')!).includes('[go][r] and ![fig][r]'));
});

/* ---------------- one recognizer, wikilink semantics verified ---------------- */

test('the renderer and the copy agree past a character reference: an escaped opener after &amp; is literal for both', async () => {
  const src = '---\ntitle: C\n---\n\na &amp; \\[[Missing]] here\n';
  const result = okResult({ files: files({ 'chasing/index.md': src }) });
  assert.equal(dec(result.bundle.get('chasing/index.md')!), src);
  assert.deepEqual(result.degraded, []);
  const rendered = await html('a &amp; \\[[Missing]] here\n');
  assert.doesNotMatch(rendered, /wikilink/);
  assert.match(rendered, /\[\[Missing\]\]/);
});

test('a degrade that would create a wikilink is refused: nested brackets, a link unwrapped around [[Other]]', () => {
  const entries = { 'chasing/other/index.md': '---\ntitle: Other\n---\n\nx\n' };
  const notes = [note('chasing', 'C'), note('chasing/other', 'Other'), note('missing', 'Missing')];
  assert.deepEqual(refusedWith({ ...entries, 'chasing/index.md': '---\ntitle: C\n---\n\n[[[[Missing|Other]]]]\n' }, { originNotes: notes }), [
    { code: 'degrade', note: 'chasing', target: 'Missing' },
  ]);
  assert.deepEqual(refusedWith({ ...entries, 'chasing/index.md': '---\ntitle: C\n---\n\n[text [[Other]]](/wiki/missing/)\n' }, { originNotes: notes }), [
    { code: 'degrade', note: 'chasing', target: '/wiki/missing/' },
  ]);
});

test('a wikilink whose source cannot be placed has no span; a placed one on a continuation line resolves like any other', () => {
  // a text node without a position (a node a plugin made) cannot be mapped
  const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'see [[Other]]' }] }] };
  assert.equal(findWikilinks(tree as never, 'see [[Other]]')[0]?.span, null);
  // behind a block quote marker the span is known: a peer collision rewrites the id
  const entries = {
    'chasing/index.md': '---\ntitle: C\n---\n\n> line\n> [[Other]]\n',
    'chasing/sub/index.md': '---\ntitle: Other\n---\n\nx\n',
  };
  const originNotes = [note('chasing', 'C'), note('chasing/sub', 'Other')];
  const kept = okResult({ files: files(entries), originNotes });
  assert.equal(dec(kept.bundle.get('chasing/index.md')!), entries['chasing/index.md']);
  const collided = okResult({ files: files(entries), originNotes, peerNotes: [peerNote('Other', 'Peer other', null)] });
  assert.equal(dec(collided.bundle.get('chasing/index.md')!), '---\ntitle: C\n---\n\n> line\n> [[chasing/sub|Other]]\n');
});

test('rewrites are built from the decoded tokens: encoded delimiters and padded spellings under a peer title collision', () => {
  const body = ['[[Other&vert;read]]', '[[Other&#124;read]]', '[[Other| read ]]', '[[ Other ]]', '[[Other&#35;Part|a*b]]'].join(' and ');
  const result = okResult({
    files: files({ 'chasing/index.md': `---\ntitle: C\n---\n\n${body}\n`, 'chasing/sub/index.md': '---\ntitle: Other\n---\n\nx\n' }),
    originNotes: [note('chasing', 'C'), note('chasing/sub', 'Other')],
    peerNotes: [peerNote('peer-other', 'Other', null)],
  });
  const copy = dec(result.bundle.get('chasing/index.md')!);
  assert.equal(
    copy,
    '---\ntitle: C\n---\n\n[[chasing/sub|read]] and [[chasing/sub|read]] and [[chasing/sub|read]] and [[chasing/sub|Other]] and [[chasing/sub#Part|a\\*b]]\n',
  );
  assert.deepEqual(result.degraded, []);
});

test('wikilinks on continuation lines are placed: list items, JSX children, nested block quotes', () => {
  const md = ['- item one', '  continues with [[Missing]] here', '', '> > quoted', '> > and [[Missing|q]] too', ''].join('\n');
  const mdResult = okResult({ files: files({ 'chasing/index.md': `---\ntitle: C\n---\n\n${md}` }) });
  assert.equal(dec(mdResult.bundle.get('chasing/index.md')!), `---\ntitle: C\n---\n\n${md.replace('[[Missing]]', 'Missing').replace('[[Missing|q]]', 'q')}`);
  const mdx = ['<Note>', '  text', '  then [[Missing]] inside', '</Note>', ''].join('\n');
  const mdxResult = okResult({ files: files({ 'chasing/index.mdx': `---\ntitle: C\n---\n\n${mdx}` }) });
  assert.equal(dec(mdxResult.bundle.get('chasing/index.mdx')!), `---\ntitle: C\n---\n\n${mdx.replace('[[Missing]]', 'Missing')}`);
  assert.equal(mdResult.degraded.length + mdxResult.degraded.length, 3);
});
