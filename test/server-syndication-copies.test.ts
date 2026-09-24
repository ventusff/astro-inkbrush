/**
 * Copies synced from another wiki are read-only here: the unit root's
 * origin block marks every file under the unit's directories, in every
 * locale, and the write primitives refuse them with 423.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { HttpError } from '../src/wiki/server/index.ts';
import { copyOrigin, copyOriginOfFile, noteMeta, writeNote } from '../src/wiki/server/source.ts';
import { setProjectRoot } from '../src/wiki/server/store.ts';
import { createWorkspace } from '../src/wiki/server/workspace.ts';

const root = mkdtempSync(join(tmpdir(), 'inkbrush-copies-'));
const notes = join(root, 'src', 'content', 'notes');
const copyStamp = 'origin:\n  wiki: vortex\n  revision: 3f9c2a1b7d4e5f60\n  synced: 2026-09-23T10:21:07Z\n';
const files: Record<string, string> = {
  'chasing/index.mdx': `---\ntitle: Chasing\n${copyStamp}---\n\nbody\n`,
  'chasing/attention/index.mdx': `---\ntitle: Attention\n${copyStamp}---\n\nsub\n`,
  'chasing/demo.ts': 'export default 1;\n',
  'en/chasing/index.mdx': `---\ntitle: Chasing (en)\n${copyStamp}---\n\nbody\n`,
  'own/index.md': '---\ntitle: Own\n---\n\nmine\n',
  'en/own/index.md': '---\ntitle: Own (en)\n---\n\nmine\n',
};
function write(entries: Record<string, string>): void {
  for (const [rel, text] of Object.entries(entries)) {
    mkdirSync(join(notes, rel, '..'), { recursive: true });
    writeFileSync(join(notes, rel), text);
  }
}
write(files);
setProjectRoot(root);
after(() => rmSync(root, { recursive: true, force: true }));

test('the unit root marks every note and file of the unit, in every locale', () => {
  const origin = { wiki: 'vortex', revision: '3f9c2a1b7d4e5f60', synced: '2026-09-23T10:21:07Z' };
  assert.deepEqual(copyOrigin('chasing'), origin);
  assert.deepEqual(copyOrigin('chasing/attention'), origin);
  assert.deepEqual(copyOrigin('en/chasing'), origin);
  assert.deepEqual(copyOriginOfFile(join(notes, 'chasing', 'demo.ts')), origin);
  assert.deepEqual(copyOriginOfFile(join(notes, 'de', 'chasing', 'index.mdx')), origin);
  assert.equal(copyOrigin('own'), null);
  assert.equal(copyOrigin('en/own'), null);
  assert.equal(copyOriginOfFile(join(root, 'elsewhere.md')), null);
  assert.deepEqual(noteMeta('chasing/attention')?.origin, origin);
  assert.equal(noteMeta('own')?.origin, undefined);
});

test('writeNote refuses a file inside a copy with 423 and writes nothing', async () => {
  const file = join(notes, 'en', 'chasing', 'index.mdx');
  await assert.rejects(
    writeNote(file, (current) => ({ next: `${current}more\n` })),
    (err: unknown) => err instanceof HttpError && err.status === 423 && err.extra['code'] === 'copy' && /synced from vortex/.test(err.message),
  );
  assert.equal(readFileSync(file, 'utf8'), files['en/chasing/index.mdx']);
  await writeNote(join(notes, 'own', 'index.md'), (current) => ({ next: `${current}more\n` }));
  assert.equal(readFileSync(join(notes, 'own', 'index.md'), 'utf8'), `${files['own/index.md']}more\n`);
});

test('a workspace apply refuses a target inside a copy', async () => {
  const ws = createWorkspace(['src/content/notes/chasing', 'src/content/notes/own']);
  try {
    await assert.rejects(
      ws.apply([{ rel: 'src/content/notes/chasing/demo.ts', content: 'export default 2;\n' }]),
      /is a copy synced from vortex — nothing was written/,
    );
    assert.equal(readFileSync(join(notes, 'chasing', 'demo.ts'), 'utf8'), 'export default 1;\n');
  } finally {
    ws.destroy();
  }
});

/* ---------------- the check happens right before the write ---------------- */

import { setSiteHooks } from '../src/wiki/server/site.ts';
import { withLock } from '../src/wiki/server/store.ts';

const stamp = (unit: string): void => {
  const file = join(notes, unit, 'index.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('---\n\n', `${copyStamp}---\n\n`));
};

test('a unit that becomes a copy while a save validates is not written', async () => {
  write({ 'late/index.md': '---\ntitle: Late\n---\n\nmine\n', 'late/sub/index.md': '---\ntitle: Sub\n---\n\nsub\n' });
  // the site's own plugin runs inside validation: the root becomes a copy meanwhile
  setSiteHooks({ remarkPlugins: [() => () => stamp('late')] });
  try {
    const file = join(notes, 'late', 'sub', 'index.md');
    await assert.rejects(writeNote(file, (current) => ({ next: `${current}more\n` })), (err: unknown) => err instanceof HttpError && err.status === 423);
    assert.equal(readFileSync(file, 'utf8'), '---\ntitle: Sub\n---\n\nsub\n');
  } finally {
    setSiteHooks(undefined);
  }
});

test('a unit that becomes a copy while an apply waits for its locks is not written', async () => {
  write({ 'later/index.md': '---\ntitle: Later\n---\n\nmine\n', 'later/demo.ts': 'export default 1;\n' });
  const ws = createWorkspace(['src/content/notes/later']);
  try {
    const target = join(notes, 'later', 'demo.ts');
    let release!: () => void;
    const held = withLock(target, () => new Promise<void>((resolve) => (release = resolve)));
    const applying = ws.apply([{ rel: 'src/content/notes/later/demo.ts', content: 'export default 2;\n' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stamp('later');
    release();
    await held;
    await assert.rejects(applying, /is a copy synced from vortex/);
    assert.equal(readFileSync(target, 'utf8'), 'export default 1;\n');
  } finally {
    ws.destroy();
  }
});
