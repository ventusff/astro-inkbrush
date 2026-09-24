import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { blobId } from '../src/lib/syndication-bundle.ts';
import { buildTree, readBlobs, readUnitInTree, writeBlobs } from '../src/lib/syndication-git.ts';

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
    { path: 'u/index.md', sha: blobs.get('u/index.md')! },
    { path: 'u/index.mdx', sha: blobs.get('u/index.mdx')! },
    { path: 'u/link', sha: blobs.get('u/link')!, mode: '120000' },
    { path: 'u/.hidden', sha: blobs.get('u/.hidden')! },
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
  const plain = await buildTree(repo, { base: null, remove: [], add: [add[0]!, { path: 'u/demo.ts', sha: blobs.get('u/link')! }], indexFile: join(dir, 'idx') });
  assert.notEqual((await readUnitInTree(repo, linked, '', 'u', [''])).digest, (await readUnitInTree(repo, plain, '', 'u', [''])).digest);
});
