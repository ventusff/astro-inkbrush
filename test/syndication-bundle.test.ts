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
  entryPart,
  fileModeOf,
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
const bundle = (files: Record<string, string>): Bundle => new Map(Object.entries(files).map(([p, t]) => [p, { bytes: enc(t), mode: '100644' }]));

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

test('collection records each file in the mode git gives it: executable iff the owner-execute bit is set', () => {
  const root = contentRoot({
    'u/index.md': '---\ntitle: U\n---\nbody\n',
    'u/run.sh': '#!/bin/sh\necho hi\n',
    'u/owner-only.sh': '#!/bin/sh\n',
    'u/others-only.sh': '#!/bin/sh\n',
    'u/plain.txt': 'text\n',
    'en/u/index.md': '---\ntitle: U (en)\n---\nbody\n',
  });
  chmodSync(join(root, 'u', 'run.sh'), 0o755);
  chmodSync(join(root, 'u', 'owner-only.sh'), 0o700);
  chmodSync(join(root, 'u', 'others-only.sh'), 0o655);
  chmodSync(join(root, 'u', 'plain.txt'), 0o644);
  chmodSync(join(root, 'en', 'u', 'index.md'), 0o755);
  const files = collectUnit(root, 'u', prefixes);
  assert.deepEqual(
    [...files].map(([path, file]) => [path, file.mode]),
    [
      ['u/index.md', '100644'],
      ['u/others-only.sh', '100644'],
      ['u/owner-only.sh', '100755'],
      ['u/plain.txt', '100644'],
      ['u/run.sh', '100755'],
      ['en/u/index.md', '100755'],
    ],
  );
  assert.equal(new TextDecoder().decode(files.get('u/run.sh')!.bytes), '#!/bin/sh\necho hi\n');
  assert.equal(fileModeOf(0o100644), '100644');
  assert.equal(fileModeOf(0o100744), '100755');
  assert.equal(fileModeOf(0o100666), '100644');
});

test('the digest of a unit without executables is what it has always been, and an executable bit alone changes it', () => {
  // pinned: a change here would show every existing copy as behind
  const plain = bundle({ 'u/index.md': '---\ntitle: T\ntags: [a, b]\n---\nbody\n', 'u/x.bin': 'bytes' });
  assert.equal(digest(plain), 'f6c52f0421d38d49');
  const nested = bundle({ 'u/index.md': '---\ntitle: T\n---\nbody\n', 'u/run.sh': '#!/bin/sh\necho hi\n', 'u/sub/index.mdx': '---\ntitle: S\n---\nsub\n' });
  assert.equal(digest(nested), '300d0a4ad3ea9174');
  const executable = (files: Bundle, path: string): Bundle => new Map([...files].map(([p, f]) => [p, p === path ? { ...f, mode: '100755' } : f]));
  assert.notEqual(digest(executable(nested, 'u/run.sh')), digest(nested));
  assert.notEqual(digest(executable(nested, 'u/index.md')), digest(nested));
  assert.notEqual(digest(executable(nested, 'u/run.sh')), digest(executable(nested, 'u/index.md')));
  assert.equal(digest(executable(nested, 'u/run.sh')), digest(executable(nested, 'u/run.sh')));
});

test('an entry digests by its content part, prefixed by its mode unless it is a plain file', () => {
  const text = '---\ntitle: T\n---\nbody\n';
  const sha = blobId(enc(text));
  const unread = (): string => {
    throw new Error('the text of a non-note or an irregular entry is never read');
  };
  assert.equal(entryPart('u/index.md', '100644', sha, () => text), notePart(text));
  assert.equal(entryPart('u/index.md', '100755', sha, () => text), `100755:${notePart(text)}`);
  assert.equal(entryPart('u/demo.ts', '100644', sha, unread), sha);
  assert.equal(entryPart('u/demo.ts', '100755', sha, unread), `100755:${sha}`);
  assert.equal(entryPart('u/index.md', '120000', sha, unread), `120000:${sha}`);
  assert.equal(entryPart('u/vendor', '160000', sha, unread), `160000:${sha}`);
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
