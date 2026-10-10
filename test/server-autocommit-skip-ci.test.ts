/**
 * `skipCi`: every autocommit message ends with its own `[skip ci]` line, so
 * GitHub Actions and dokploy leave the push alone; off by default, and the
 * `WIKI_SKIP_CI` flag outranks the config file.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { setConfigInput, wikiConfig } from '../src/wiki/server/config.ts';
import { setProjectRoot } from '../src/wiki/server/store.ts';

function resolvedSkipCi(input: Parameters<typeof setConfigInput>[0], env?: string): boolean {
  const before = process.env['WIKI_SKIP_CI'];
  if (env === undefined) delete process.env['WIKI_SKIP_CI'];
  else process.env['WIKI_SKIP_CI'] = env;
  setConfigInput(input);
  try {
    return wikiConfig().skipCi;
  } finally {
    setConfigInput(null);
    if (before === undefined) delete process.env['WIKI_SKIP_CI'];
    else process.env['WIKI_SKIP_CI'] = before;
  }
}

test('skipCi is off by default, on from the config, and the env flag outranks the file', () => {
  assert.equal(resolvedSkipCi({}), false);
  assert.equal(resolvedSkipCi({ skipCi: true }), true);
  assert.equal(resolvedSkipCi({ skipCi: true }, '0'), false);
  assert.equal(resolvedSkipCi({}, '1'), true);
});

test('with skipCi the autocommit message carries [skip ci] as a trailing line of its own; the author is the person, cleaned for git', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'inkbrush-skip-ci-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@local');
  git('config', 'user.name', 'test');
  const notes = join(repo, 'src', 'content', 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'a.md'), '# a\n');

  const cwd = process.cwd();
  setProjectRoot(repo);
  setConfigInput({ autocommit: true, skipCi: true, content: { dir: 'src/content/notes' } });
  try {
    const { autocommit } = await import('../src/wiki/server/source.ts');
    assert.equal(await autocommit('src/content/notes/a.md', 'wiki: a L1-1 manual edit', { name: 'Tester', email: 'tester@corp.test' }), 'committed');
    assert.equal(git('log', '-1', '--format=%B').trimEnd(), 'wiki: a L1-1 manual edit\n\n[skip ci]');
    assert.equal(git('log', '-1', '--format=%an <%ae>').trim(), 'Tester <tester@corp.test>');

    writeFileSync(join(notes, 'a.md'), '# b\n');
    assert.equal(await autocommit('src/content/notes/a.md', 'wiki: a L1-1 manual edit', { name: 'Odd <x>\nName', email: 'odd@corp.test' }), 'committed');
    assert.equal(git('log', '-1', '--format=%an <%ae>').trim(), 'Odd x Name <odd@corp.test>');

    writeFileSync(join(notes, 'a.md'), '# c\n');
    assert.equal(await autocommit('src/content/notes/a.md', 'wiki: a L1-1 manual edit', { name: ' ', email: 'blank.name@corp.test' }), 'committed');
    assert.equal(git('log', '-1', '--format=%an <%ae>').trim(), 'blank.name <blank.name@corp.test>');
  } finally {
    setConfigInput(null);
    setProjectRoot(cwd);
  }
});
