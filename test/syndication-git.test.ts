import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { blobId, collectUnit, digest } from '../src/lib/syndication-bundle.ts';
import { buildTree, GitError, readBlobs, readUnitInTree, writeBlobs } from '../src/lib/syndication-git.ts';

const base = mkdtempSync(join(tmpdir(), 'inkbrush-git-'));
after(() => rmSync(base, { recursive: true, force: true }));

test('blobs are written without clean filters: the stored bytes are the bytes the digest saw', async () => {
  const dir = join(base, 'checkout');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'core.autocrlf', 'true']);
  const crlf = new TextEncoder().encode('line one\r\nline two\r\n');
  const ids = await writeBlobs(dir, new Map([['u/notes.txt', crlf]]), join(base, 'scratch'));
  assert.equal(ids.get('u/notes.txt'), blobId(crlf));
  const stored = await readBlobs(dir, [ids.get('u/notes.txt')!]);
  assert.deepEqual(new Uint8Array(stored.get(ids.get('u/notes.txt')!)!), crlf);
});

test('a unit read from a tree names irregular entries, dot segments and duplicate note files; its digest never treats them as files', async () => {
  const dir = join(base, 'tree.git');
  execFileSync('git', ['init', '-q', '--bare', dir]);
  const repo = { cwd: dir, gitDir: dir };
  const note = new TextEncoder().encode('---\ntitle: U\n---\nbody\n');
  const blobs = await writeBlobs(repo, new Map([['u/index.md', note], ['u/index.mdx', note], ['u/link', new TextEncoder().encode('../secret')], ['u/.hidden', note]]), join(base, 'scratch-tree'));
  const add = [
    { path: 'u/index.md', sha: blobs.get('u/index.md')!, mode: '100644' },
    { path: 'u/index.mdx', sha: blobs.get('u/index.mdx')!, mode: '100644' },
    { path: 'u/link', sha: blobs.get('u/link')!, mode: '120000' },
    { path: 'u/.hidden', sha: blobs.get('u/.hidden')!, mode: '100644' },
    { path: 'u/sub', sha: 'a'.repeat(40), mode: '160000' },
  ];
  const tree = await buildTree(repo, { base: null, remove: [], add, indexFile: join(dir, 'idx') });
  const unit = await readUnitInTree(repo, tree, '', 'u', ['']);
  assert.deepEqual(unit.problems.map((p) => p.split(':')[0]).sort(), ['u/.hidden', 'u/index.mdx', 'u/link', 'u/sub'].sort());
  const regular = await buildTree(repo, { base: null, remove: [], add: [add[0]!], indexFile: join(dir, 'idx') });
  const clean = await readUnitInTree(repo, regular, '', 'u', ['']);
  assert.notEqual(unit.digest, clean.digest);
  // a symlink whose blob equals a regular file's still digests differently
  const linked = await buildTree(repo, { base: null, remove: [], add: [add[0]!, { path: 'u/demo.ts', sha: blobs.get('u/link')!, mode: '120000' }], indexFile: join(dir, 'idx') });
  const plain = await buildTree(repo, { base: null, remove: [], add: [add[0]!, { path: 'u/demo.ts', sha: blobs.get('u/link')!, mode: '100644' }], indexFile: join(dir, 'idx') });
  assert.notEqual((await readUnitInTree(repo, linked, '', 'u', [''])).digest, (await readUnitInTree(repo, plain, '', 'u', [''])).digest);
});

test('a unit with an executable file digests alike from its bytes and from the tree that holds it in its modes', async () => {
  const content = join(base, 'content');
  mkdirSync(join(content, 'u', 'sub'), { recursive: true });
  writeFileSync(join(content, 'u', 'index.md'), '---\ntitle: U\n---\nbody\n');
  writeFileSync(join(content, 'u', 'run.sh'), '#!/bin/sh\necho hi\n');
  writeFileSync(join(content, 'u', 'sub', 'index.md'), '---\ntitle: S\n---\nsub\n');
  chmodSync(join(content, 'u', 'run.sh'), 0o755);
  chmodSync(join(content, 'u', 'sub', 'index.md'), 0o755);
  const files = collectUnit(content, 'u', ['']);
  assert.equal(files.get('u/run.sh')!.mode, '100755');

  const dir = join(base, 'modes.git');
  execFileSync('git', ['init', '-q', '--bare', dir]);
  const repo = { cwd: dir, gitDir: dir };
  const blobs = await writeBlobs(repo, new Map([...files].map(([path, file]) => [path, file.bytes])), join(base, 'scratch-modes'));
  const add = [...files].map(([path, file]) => ({ path, sha: blobs.get(path)!, mode: file.mode }));
  const tree = await buildTree(repo, { base: null, remove: [], add, indexFile: join(dir, 'idx') });
  const unit = await readUnitInTree(repo, tree, '', 'u', ['']);
  assert.deepEqual(unit.problems, []);
  assert.deepEqual(
    unit.entries.map((e) => [e.path, e.mode]),
    [
      ['u/index.md', '100644'],
      ['u/run.sh', '100755'],
      ['u/sub/index.md', '100755'],
    ],
  );
  assert.equal(unit.digest, digest(files));
  // the same bytes as plain files are another unit
  const plain = await buildTree(repo, { base: null, remove: [], add: add.map((e) => ({ ...e, mode: '100644' })), indexFile: join(dir, 'idx') });
  assert.notEqual((await readUnitInTree(repo, plain, '', 'u', [''])).digest, unit.digest);
});

test("a git error's summary is its first non-empty line, without the CR of ssh's CRLF line ends", () => {
  const err = new GitError(['fetch'], '\r\ngit@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\r\n');
  assert.equal(err.summary, 'git@github.com: Permission denied (publickey).');
  assert.equal(err.message, 'git@github.com: Permission denied (publickey).');
  assert.equal(new GitError(['push'], '').summary, 'git push failed');
});
