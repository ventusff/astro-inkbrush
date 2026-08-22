/**
 * Note discovery: YAML frontmatter parsing (quoting, both list syntaxes,
 * comments, CRLF, scalar coercion, malformed YAML) and directory scanning
 * (symlinks inside and outside the content root, symlink cycles, a
 * directory holding both index.md and index.mdx).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { noteInfoFromSource, scanNotes } from '../src/lib/wikilinks.ts';

/* ---------------- frontmatter ---------------- */

test('quoted values keep their commas, colons and hash signs', () => {
  const info = noteInfoFromSource(
    'n',
    ['---', 'title: "Deploy: step 1, #3"', "brand: 'Acme, Inc.'", '---', 'body'].join('\n'),
  );
  assert.equal(info.title, 'Deploy: step 1, #3');
  assert.equal(info.brand, 'Acme, Inc.');
});

test('aliases accept flow and block sequences, with quoted items', () => {
  const flow = noteInfoFromSource('n', ['---', 'aliases: [setup, "quick, start", \'x: y\']', '---'].join('\n'));
  assert.deepEqual(flow.aliases, ['setup', 'quick, start', 'x: y']);
  const block = noteInfoFromSource(
    'n',
    ['---', 'aliases:', '  - setup', '  - "quick, start"', "  - 'x: y'", 'title: T', '---'].join('\n'),
  );
  assert.deepEqual(block.aliases, ['setup', 'quick, start', 'x: y']);
  assert.equal(block.title, 'T');
});

test('a lone scalar alias is a one-item list; non-scalar items are dropped', () => {
  assert.deepEqual(noteInfoFromSource('n', '---\naliases: solo\n---').aliases, ['solo']);
  assert.deepEqual(noteInfoFromSource('n', '---\naliases:\n  - ok\n  - {nested: map}\n  - 7\n---').aliases, ['ok', '7']);
});

test('comments are not values', () => {
  const info = noteInfoFromSource(
    'n',
    ['---', '# leading comment', 'title: Real title # trailing comment', 'aliases:', '  # a comment line', '  - a', '---'].join(
      '\n',
    ),
  );
  assert.equal(info.title, 'Real title');
  assert.deepEqual(info.aliases, ['a']);
});

test('CRLF frontmatter parses the same as LF', () => {
  const lf = noteInfoFromSource('n', '---\ntitle: Same\nbrand: B\naliases:\n  - a\n  - b\n---\n\nbody\n');
  const crlf = noteInfoFromSource('n', '---\r\ntitle: Same\r\nbrand: B\r\naliases:\r\n  - a\r\n  - b\r\n---\r\n\r\nbody\r\n');
  assert.deepEqual(crlf, lf);
  assert.equal(crlf.title, 'Same');
});

test('escapes and multi-line scalars are decoded', () => {
  const info = noteInfoFromSource('n', '---\ntitle: "Tab\\tand \\"quotes\\""\nbrand: >-\n  folded\n  brand\n---');
  assert.equal(info.title, 'Tab\tand "quotes"');
  assert.equal(info.brand, 'folded brand');
});

test('numbers and booleans become strings; maps, nulls and empty values are absent', () => {
  const info = noteInfoFromSource('n', '---\ntitle: 2024\nbrand: true\n---');
  assert.equal(info.title, '2024');
  assert.equal(info.brand, 'true');
  const absent = noteInfoFromSource('n', '---\ntitle:\nbrand: { a: b }\naliases: ~\n---');
  assert.equal(absent.title, 'n');
  assert.equal(absent.brand, undefined);
  assert.deepEqual(absent.aliases, []);
});

test('a BOM or leading blank lines before the frontmatter are accepted', () => {
  assert.equal(noteInfoFromSource('n', '\uFEFF---\ntitle: Bom\n---').title, 'Bom');
  assert.equal(noteInfoFromSource('n', '\n\n---\ntitle: Blank\n---').title, 'Blank');
});

test('malformed YAML, a non-mapping document, and no frontmatter all fall back to the id', () => {
  for (const source of ['---\ntitle: [unclosed\n---', '---\n- just\n- a list\n---', '# no frontmatter\ntitle: nope', '']) {
    assert.deepEqual(noteInfoFromSource('fallback', source), { id: 'fallback', title: 'fallback', brand: undefined, aliases: [] });
  }
});

/* ---------------- directory scanning ---------------- */

const tmp = mkdtempSync(join(tmpdir(), 'inkbrush-scan-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function note(dir: string, file: string, title: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\ntitle: ${title}\n---\n`);
}

test('symlinks inside the root are followed once; symlinks leaving the root are not', () => {
  const root = join(tmp, 'inside');
  note(join(root, 'real'), 'index.md', 'Real');
  note(join(root, 'nested', 'child'), 'index.mdx', 'Child');
  note(join(tmp, 'outside', 'secret'), 'index.md', 'Secret');
  symlinkSync(join(root, 'nested'), join(root, 'via-link'));
  symlinkSync(join(tmp, 'outside'), join(root, 'escape'));
  symlinkSync(join(tmp, 'outside', 'secret', 'index.md'), join(root, 'real', 'index.mdx'));
  symlinkSync(root, join(root, 'nested', 'loop'));

  const ids = scanNotes(root)
    .map((n) => n.id)
    .sort();
  // via-link reaches a real directory already scanned: not a second note;
  // escape leaves the root; the loop points back at the root; the file
  // symlink real/index.mdx leaves the root so real/ keeps its single index.md
  assert.deepEqual(ids, ['nested/child', 'real']);
});

test('a symlink to a directory not reached by any other path is scanned under the link name', () => {
  const root = join(tmp, 'linked');
  mkdirSync(root, { recursive: true });
  note(join(root, '_meta', 'hidden-by-skip'), 'index.md', 'Skipped');
  symlinkSync(join(root, '_meta', 'hidden-by-skip'), join(root, 'shown'));
  assert.deepEqual(
    scanNotes(root).map((n) => [n.id, n.title]),
    [['shown', 'Skipped']],
  );
});

test('a directory holding both index.md and index.mdx is a hard error naming the directory', () => {
  const root = join(tmp, 'dup');
  note(join(root, 'twice'), 'index.md', 'A');
  note(join(root, 'twice'), 'index.mdx', 'B');
  assert.throws(() => scanNotes(root), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /both index\.md and index\.mdx/);
    assert.match(err.message, /"twice"/);
    return true;
  });
});

test('a missing content directory yields no notes', () => {
  assert.deepEqual(scanNotes(join(tmp, 'does-not-exist')), []);
});
