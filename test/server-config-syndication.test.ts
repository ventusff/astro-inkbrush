/**
 * Syndication config resolution: the peer's content directory is stored
 * as a canonical repo-relative prefix, and its branch name is held to
 * git's own rules.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { setConfigInput, wikiConfig } from '../src/wiki/server/config.ts';
import { checkBranchName } from '../src/wiki/server/config-checks.ts';

const peer = { id: 'p', title: 'P', repo: 'git@example:x/y.git', url: 'https://p.example/{id}/' };

function resolved(contentDir: string): string {
  setConfigInput({ syndication: { name: 'v', peers: [{ ...peer, contentDir }] } });
  try {
    return wikiConfig().syndication.peers[0]!.contentDir;
  } finally {
    setConfigInput(null);
  }
}

test('contentDir resolves to a canonical repo-relative prefix; absolute and traversing spellings fail at startup', () => {
  for (const spelling of ['', '.', './', './/']) assert.equal(resolved(spelling), '', JSON.stringify(spelling));
  for (const spelling of ['notes', 'notes/', './notes', 'notes/./', 'notes//sub/']) {
    assert.equal(resolved(spelling), spelling.includes('sub') ? 'notes/sub/' : 'notes/', JSON.stringify(spelling));
  }
  for (const bad of ['/', '/notes/', '../x', 'notes/../../x', 'notes/../other', 'notes/../', '\\\\server\\share']) {
    assert.throws(() => resolved(bad), /contentDir/, JSON.stringify(bad));
  }
});

test('branch names are held to git check-ref-format --branch', () => {
  const names = ['main', 'main/', 'main.lock/x', 'main@{1}', 'main.', 'feature/x', 'a..b', '-x', 'HEAD', 'a b', 'a//b', '.hidden', 'x~1', 'x^', 'x:y', 'x?', 'x*', 'x[', 'x\\', 'x.lock', 'refs/heads/x', 'a/.b', 'ok-1.2', 'x\u0001y', '/x', 'a/b.lock'];
  for (const name of names) {
    let git = true;
    try {
      execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' });
    } catch {
      git = false;
    }
    assert.equal(checkBranchName(name) === null, git, `${JSON.stringify(name)}: git says ${git ? 'valid' : 'invalid'}`);
  }
  setConfigInput({ syndication: { name: 'v', peers: [{ ...peer, branch: 'main@{1}' }] } });
  try {
    assert.throws(() => wikiConfig(), /branch/);
  } finally {
    setConfigInput(null);
  }
});
