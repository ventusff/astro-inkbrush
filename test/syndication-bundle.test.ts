import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { splitFrontmatter } from '../src/lib/frontmatter.ts';
import {
  blobId,
  collectUnit,
  digest,
  inUnitRoots,
  notePart,
  stableJson,
  unitNameProblem,
  unitOf,
  unitRoots,
  type Bundle,
} from '../src/lib/syndication-bundle.ts';

const locales = [{ prefix: '' }, { prefix: 'en/' }, { prefix: 'de/' }];
const prefixes = ['', 'en/', 'de/'];
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function contentRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-unit-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const bundle = (files: Record<string, string>): Bundle => new Map(Object.entries(files).map(([p, t]) => [p, enc(t)]));

test('a note id names its unit through its locale prefix', () => {
  assert.equal(unitOf('chasing', locales), 'chasing');
  assert.equal(unitOf('chasing/attention', locales), 'chasing');
  assert.equal(unitOf('en/chasing/attention', locales), 'chasing');
  assert.equal(unitOf('en', locales), '');
  assert.deepEqual(unitRoots('chasing', prefixes), ['chasing', 'en/chasing', 'de/chasing']);
  assert.equal(inUnitRoots('en/chasing/demo.ts', 'chasing', prefixes), true);
  assert.equal(inUnitRoots('chasing-two/index.md', 'chasing', prefixes), false);
  assert.equal(inUnitRoots('fr/chasing/index.md', 'chasing', prefixes), false);
});

test('collection takes every locale root, regular files only, no dot entries, no symlinks', () => {
  const root = contentRoot({
    'chasing/index.mdx': '---\ntitle: C\n---\nbody',
    'chasing/attention/index.mdx': '---\ntitle: A\n---\nsub',
    'chasing/demo.ts': 'export default 1;',
    'chasing/_meta/x.json': '{}',
    'chasing/.hidden': 'no',
    'en/chasing/index.mdx': '---\ntitle: C (en)\n---\nbody',
    'other/index.md': 'not ours',
  });
  symlinkSync(join(root, 'other'), join(root, 'chasing', 'link'));
  const files = collectUnit(root, 'chasing', prefixes);
  assert.deepEqual(
    [...files.keys()],
    ['chasing/_meta/x.json', 'chasing/attention/index.mdx', 'chasing/demo.ts', 'chasing/index.mdx', 'en/chasing/index.mdx'],
  );
  assert.throws(() => collectUnit(root, 'other-missing', prefixes), /is not a unit/);
  // a locale root alone is not a unit either
  const en = contentRoot({ 'en/solo/index.md': 'x' });
  assert.throws(() => collectUnit(en, 'solo', prefixes), /is not a unit/);
});

test('the digest ignores insertion order, frontmatter formatting and the origin block, never a body or a byte', () => {
  const a = bundle({ 'u/index.md': '---\ntitle: T\ntags: [a, b]\n---\nbody\n', 'u/x.bin': 'bytes' });
  const b = bundle({ 'u/x.bin': 'bytes', 'u/index.md': '---\ntags:\n  - a\n  - b\ntitle: "T"\norigin:\n  wiki: v\n  revision: ffffffffffffffff\n  synced: 2026-01-01T00:00:00Z\n---\nbody\n' });
  assert.equal(digest(a), digest(b));
  assert.match(digest(a), /^[0-9a-f]{16}$/);
  const body = bundle({ 'u/index.md': '---\ntitle: T\ntags: [a, b]\n---\nbody!\n', 'u/x.bin': 'bytes' });
  assert.notEqual(digest(a), digest(body));
  const bytes = bundle({ 'u/index.md': '---\ntitle: T\ntags: [a, b]\n---\nbody\n', 'u/x.bin': 'byteS' });
  assert.notEqual(digest(a), digest(bytes));
  const renamed = bundle({ 'u/index.md': '---\ntitle: T\ntags: [a, b]\n---\nbody\n', 'u/y.bin': 'bytes' });
  assert.notEqual(digest(a), digest(renamed));
  // a note whose frontmatter does not parse hashes as written
  assert.notEqual(notePart('---\nbad: [\n---\nbody'), notePart('---\nbad:  [\n---\nbody'));
});

test('a non-note part is the git blob id, so a tree listing yields the same digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-blob-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'f.bin'), 'hello blob\n');
  const fromGit = execFileSync('git', ['hash-object', join(dir, 'f.bin')], { encoding: 'utf8' }).trim();
  assert.equal(blobId(enc('hello blob\n')), fromGit);
});

test('stableJson sorts object keys at every depth and keeps arrays in order', () => {
  assert.equal(stableJson({ b: [2, { z: 1, a: 0 }], a: 'x' }), '{"a":"x","b":[2,{"a":0,"z":1}]}');
  assert.equal(stableJson(undefined), 'null');
});

test('a symlink in any component of a unit root (a locale directory included) lets nothing in', () => {
  const outside = contentRoot({ 'u/index.md': '---\ntitle: leaked\n---\n', 'u/secret.txt': 'private' });
  const root = contentRoot({ 'u/index.md': '---\ntitle: U\n---\n' });
  symlinkSync(outside, join(root, 'en'));
  mkdirSync(join(root, 'de'));
  symlinkSync(join(outside, 'u'), join(root, 'de', 'u'));
  assert.deepEqual([...collectUnit(root, 'u', prefixes).keys()], ['u/index.md']);
});

test('a directory that cannot be read fails the collection instead of shrinking the unit', { skip: process.getuid?.() === 0 }, () => {
  const root = contentRoot({ 'u/index.md': '---\ntitle: U\n---\n', 'u/assets/a.png': 'png' });
  chmodSync(join(root, 'u', 'assets'), 0o000);
  try {
    assert.throws(() => collectUnit(root, 'u', prefixes), /EACCES/);
  } finally {
    chmodSync(join(root, 'u', 'assets'), 0o755);
  }
});

test('cyclic frontmatter (self-referencing aliases) hashes as written, on both sides alike', () => {
  const cyclic = '---\na: &a [*a]\ntitle: T\n---\nbody\n';
  assert.doesNotThrow(() => notePart(cyclic));
  assert.notEqual(notePart(cyclic), notePart(cyclic.replace('title: T', 'title:  T')));
  assert.throws(() => stableJson(splitFrontmatter(cyclic).data), /cycl/);
});

test('a unit is one note id segment that is neither a reserved root directory nor a locale directory', () => {
  for (const ok of ['chasing', 'a-b_c.d', '中文', 'x1']) assert.equal(unitNameProblem(ok, prefixes), null, ok);
  for (const bad of ['a/b', '.hidden', '-x', '', '_meta', 'docs', 'inbox', 'en', 'de']) {
    assert.notEqual(unitNameProblem(bad, prefixes), null, JSON.stringify(bad));
  }
  assert.equal(unitNameProblem('en', ['']), null);
});

test('canonicalization tells YAML types apart: timestamps, sets, non-finite numbers, binary, ordered maps', () => {
  const part = (fm: string): string => notePart(`---\n${fm}\n---\nbody\n`);
  assert.notEqual(part('d: !!timestamp 2025-01-01'), part('d: !!timestamp 2026-01-01'));
  assert.notEqual(part('d: !!timestamp 2025-01-01'), part('d: 2025-01-01'));
  assert.notEqual(part('s: !!set {a, b}'), part('s: !!set {a, c}'));
  assert.notEqual(part('s: !!set {a, b}'), part('s: [a, b]'));
  assert.notEqual(part('n: .inf'), part('n: .nan'));
  assert.notEqual(part('n: .inf'), part('n: null'));
  assert.notEqual(part('n: -.inf'), part('n: .inf'));
  assert.notEqual(part('b: !!binary aGk='), part('b: !!binary aG8='));
  assert.notEqual(part('o: !!omap [a: 1]'), part('o: {a: 1}'));
  // the representation is explicit and cannot collide with JSON of plain values
  assert.equal(stableJson(new Date('2025-01-01T00:00:00Z')), '<date:2025-01-01T00:00:00.000Z>');
  assert.equal(stableJson(new Set(['b', 'a'])), '<set:["b","a"]>');
  assert.equal(stableJson(Infinity), '<number:Infinity>');
  assert.equal(stableJson(new Uint8Array([104, 105])), '<bytes:aGk=>');
  assert.equal(stableJson(new Map([['a', 1]])), '<map:[["a",1]]>');
  assert.equal(stableJson({ '<date:x>': 1 }), '{"<date:x>":1}');
  assert.throws(() => stableJson(() => 1), /cannot be canonicalized/);
});

test('a unit name must also make valid staging and verdict refs', () => {
  for (const bad of ['guide..v2', 'guide.lock', 'guide.']) assert.match(unitNameProblem(bad, prefixes) ?? '', /ref/, bad);
  assert.notEqual(unitNameProblem('guide@{1', prefixes), null);
  assert.equal(unitNameProblem('guide-v2', prefixes), null);
});

test('a note whose YAML cannot be converted (alias flood) never throws: the block reads as an error, the part is the raw text', () => {
  const flood = `---\na: &a [1]\nb: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\ntitle: T\n---\nbody\n`;
  const fm = splitFrontmatter(flood);
  assert.equal(fm.present, true);
  assert.match(fm.error?.message ?? '', /alias/i);
  assert.deepEqual(fm.data, {});
  assert.doesNotThrow(() => notePart(flood));
  assert.notEqual(notePart(flood), notePart(flood.replace('title: T', 'title:  T')));
});

test('node_modules is reserved, like every name the receiving checks skip', () => {
  assert.match(unitNameProblem('node_modules', prefixes) ?? '', /reserved/);
});
