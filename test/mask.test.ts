/**
 * Parser-based source masking: every non-prose construct the dialect's
 * parser recognises is blanked at equal length, so [[wikilink]] extraction
 * sees exactly the text the page renders as prose.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractWikilinks, maskNonProse } from '../src/lib/wikilinks.ts';

function targets(source: string, mdx = false): string[] {
  return extractWikilinks(source, { mdx }).map((l) => l.target);
}

function sameShape(source: string, masked: string): void {
  assert.equal(masked.length, source.length);
  assert.deepEqual(
    masked.split('\n').map((l) => l.length),
    source.split('\n').map((l) => l.length),
  );
}

test('masking keeps length and line structure, including CRLF', () => {
  const source = '---\r\ntitle: T\r\n---\r\n\r\n`[[a]]` and [[b]]\r\n\r\n```\r\n[[c]]\r\n```\r\n';
  const masked = maskNonProse(source);
  sameShape(source, masked);
  assert.ok(masked.includes('\r\n'));
  assert.deepEqual(targets(source), ['b']);
});

test('multi-backtick code spans are code', () => {
  const source = 'a `` [[one]] ` [[two]] `` b ``` [[three]] ``` c [[four]]';
  assert.deepEqual(targets(source), ['four']);
});

test('indented code blocks are code', () => {
  const source = ['prose [[one]]', '', '    [[two]] indented', '    [[three]]', '', 'prose [[four]]'].join('\n');
  assert.deepEqual(targets(source), ['one', 'four']);
});

test('tilde fences, longer fences and unterminated fences are code', () => {
  const tilde = ['~~~js', '[[one]]', '~~~', '', '[[two]]'].join('\n');
  assert.deepEqual(targets(tilde), ['two']);
  const longer = ['````', '```', '[[one]]', '```', '````', '[[two]]'].join('\n');
  assert.deepEqual(targets(longer), ['two']);
  const open = ['[[zero]]', '', '```', '[[one]]', 'never closed'].join('\n');
  assert.deepEqual(targets(open), ['zero']);
});

test('HTML blocks and inline tags are not prose', () => {
  const block = ['<div class="x">', '[[one]]', '</div>', '', '[[two]]', '', '<!-- [[three]] -->', '', '<table><tr><td>[[four]]</td></tr></table>'].join(
    '\n',
  );
  assert.deepEqual(targets(block), ['two']);
  const inline = 'text <span title="[[one]]">[[two]]</span> <br/> [[three]]';
  assert.deepEqual(targets(inline), ['two', 'three']);
});

test('inline and display math are not prose', () => {
  const source = ['prose $[[one]]$ and $$[[two]]$$', '', '$$', '[[three]]', '$$', '', '[[four]]'].join('\n');
  assert.deepEqual(targets(source), ['four']);
});

test('a link nested in a code span inside a table cell is still code', () => {
  const source = ['| a | b |', '| - | - |', '| `[[one]]` | [[two]] |'].join('\n');
  assert.deepEqual(targets(source), ['two']);
});

test('links, images and definitions are not prose; footnote bodies are', () => {
  const source = [
    '[see [[one]]](https://x.example) and ![alt [[two]]](i.png) and [[three]](#ref-1)',
    '',
    '[ref]: https://x.example "[[four]]"',
    '',
    'https://x.example/[[five]] autolinked',
    '',
    'prose [[six]][^n]',
    '',
    '[^n]: footnote [[seven]]',
  ].join('\n');
  assert.deepEqual(targets(source), ['six', 'seven']);
});

test('a [[…]] torn across table cells is not a wikilink; one inside a cell is', () => {
  const source = ['| a | b |', '| - | - |', '| [[torn | apart]] |', '| [[whole]] | [[also#here]] |'].join('\n');
  assert.deepEqual(targets(source), ['whole', 'also']);
  // the masked text itself keeps the cell text (cuts are applied at extraction)
  assert.ok(maskNonProse(source).includes('[[torn | apart]]'));
});

test('escaped constructs that the parser reads as prose stay prose', () => {
  assert.deepEqual(targets('\\`[[one]]\\` and \\<b>[[two]]\\</b>'), ['one', 'two']);
});

test('frontmatter is blanked only at the top of the file', () => {
  const source = ['---', 'title: "[[one]]"', '---', '', '[[two]]', '', '---', '', 'a horizontal rule, then [[three]]'].join('\n');
  assert.deepEqual(targets(source), ['two', 'three']);
});

test('offsets point into the original source', () => {
  const source = ['~~~', '[[skip]]', '~~~', '', 'x `[[skip]]` [[keep#Head|Label]] y'].join('\n');
  const [link] = extractWikilinks(source);
  assert.ok(link);
  assert.equal(source.slice(link.offset, link.offset + link.raw.length), '[[keep#Head|Label]]');
  assert.deepEqual([link.target, link.anchor, link.label], ['keep', 'Head', 'Label']);
});

/* ---------------- MDX ---------------- */

test('with the MDX grammar, JSX tags and expressions are blanked and JSX children stay prose', () => {
  const source = [
    'import { Aside } from "../c.astro";',
    'export const meta = "[[zero]]";',
    '',
    '<Aside title="[[one]]" kind={"[[two]]"}>',
    '  prose [[three]] and {/* [[four]] */} and <Kbd>[[five]]</Kbd>',
    '</Aside>',
    '',
    '{[[six]].length}',
    '',
    'tail [[seven]]',
  ].join('\n');
  assert.deepEqual(targets(source, true), ['three', 'five', 'seven']);
  const masked = maskNonProse(source, { mdx: true });
  sameShape(source, masked);
  assert.equal(masked.includes('Aside'), false);
  assert.equal(masked.includes('import'), false);
});

test('the same source read as CommonMark masks the JSX block as HTML', () => {
  const source = ['<Aside title="[[one]]">', '  prose [[two]]', '</Aside>', '', 'tail [[three]]'].join('\n');
  assert.deepEqual(targets(source), ['three']);
  assert.deepEqual(targets(source, true), ['two', 'three']);
});

test('MDX that does not parse falls back to the CommonMark reading and never throws', () => {
  const broken = 'an unclosed <Tag attr="x" [[one]]\n\n{ unbalanced [[two]]';
  assert.doesNotThrow(() => maskNonProse(broken, { mdx: true }));
  assert.deepEqual(targets(broken, true), targets(broken));
});
