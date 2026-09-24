import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decide,
  parseStagingBranch,
  parseSubmission,
  stagingBranch,
  submissionMessage,
  unitStateFrom,
  verdictPath,
  type UnitState,
} from '../src/lib/syndication-state.ts';

const rev = 'aaaaaaaaaaaaaaaa';
const other = 'bbbbbbbbbbbbbbbb';
const copy = (digest = rev): UnitState => ({ kind: 'copy', revision: rev, digest });

test('a submission is decided by the unit state, the expectation and force', () => {
  assert.deepEqual(decide({ kind: 'absent' }, 'none', false, 'publish'), { ok: true });
  assert.deepEqual(decide({ kind: 'absent' }, 'adopt', false, 'publish'), { ok: true });
  assert.equal(decide({ kind: 'absent' }, { revision: rev }, false, 'publish').ok, false);
  assert.equal((decide({ kind: 'absent' }, { revision: rev }, true, 'withdraw') as { code: string }).code, 'gone');
  assert.equal((decide({ kind: 'native' }, 'none', false, 'publish') as { code: string }).code, 'native');
  assert.deepEqual(decide({ kind: 'native' }, 'adopt', false, 'publish'), { ok: true });
  assert.equal((decide({ kind: 'native' }, 'adopt', true, 'withdraw') as { code: string }).code, 'native');
  assert.equal((decide({ kind: 'foreign', wiki: 'x' }, 'adopt', true, 'publish') as { code: string }).code, 'foreign');
  assert.deepEqual(decide(copy(), { revision: rev }, false, 'publish'), { ok: true });
  assert.deepEqual(decide(copy(), { revision: rev }, false, 'withdraw'), { ok: true });
  const moved = decide(copy(), { revision: other }, false, 'publish');
  assert.equal(moved.ok, false);
  assert.equal((moved as { code: string; revision: string }).code, 'moved');
  assert.equal((moved as { code: string; revision: string }).revision, rev);
  assert.equal((decide(copy(), 'none', false, 'publish') as { code: string }).code, 'moved');
  assert.equal((decide(copy(other), { revision: rev }, false, 'publish') as { code: string }).code, 'changed');
  assert.deepEqual(decide(copy(other), { revision: rev }, true, 'publish'), { ok: true });
});

test('the commit message round-trips the submission; refs follow the naming', () => {
  const s = { origin: 'vortex-wiki', unit: 'chasing', action: 'publish' as const, expect: { revision: other }, revision: rev, force: true };
  const message = submissionMessage(s);
  assert.equal(
    message,
    `wiki: chasing synced from vortex-wiki (${rev})\n\nSyndication-Origin: vortex-wiki\nSyndication-Unit: chasing\nSyndication-Action: publish\nSyndication-Expect: ${other}\nSyndication-Revision: ${rev}\nSyndication-Force: yes\n`,
  );
  assert.deepEqual(parseSubmission(message), { ok: true, submission: s });
  const w = { origin: 'vortex-wiki', unit: 'chasing', action: 'withdraw' as const, expect: { revision: rev }, revision: undefined, force: false };
  assert.equal(submissionMessage(w).split('\n')[0], 'wiki: chasing withdrawn by vortex-wiki');
  assert.deepEqual(parseSubmission(submissionMessage(w)), { ok: true, submission: w });
  assert.equal(stagingBranch('vortex-wiki', 'chasing'), 'syndicate/vortex-wiki/chasing');
  assert.equal(verdictPath('vortex-wiki', 'chasing'), 'vortex-wiki/chasing.json');
  assert.deepEqual(parseStagingBranch('syndicate/vortex-wiki/chasing'), { origin: 'vortex-wiki', unit: 'chasing' });
  assert.equal(parseStagingBranch('main'), null);
  assert.equal(parseStagingBranch('syndicate/a/b/c'), null);
});

test('a message without valid trailers describes no submission', () => {
  assert.equal(parseSubmission('wiki: chasing synced\n').ok, false);
  assert.match((parseSubmission('x\n\nSyndication-Origin: Bad Name\nSyndication-Unit: u\nSyndication-Action: publish\nSyndication-Expect: none\nSyndication-Revision: ' + rev + '\n') as { problem: string }).problem, /Origin/);
  assert.match((parseSubmission('x\n\nSyndication-Origin: v\nSyndication-Unit: u\nSyndication-Action: publish\nSyndication-Expect: none\n') as { problem: string }).problem, /Revision/);
  assert.match((parseSubmission('x\n\nSyndication-Origin: v\nSyndication-Unit: a/b\nSyndication-Action: withdraw\nSyndication-Expect: none\n') as { problem: string }).problem, /Unit/);
  assert.match((parseSubmission('x\n\nSyndication-Origin: v\nSyndication-Unit: u\nSyndication-Action: delete\nSyndication-Expect: none\n') as { problem: string }).problem, /Action/);
  assert.match((parseSubmission('x\n\nSyndication-Origin: v\nSyndication-Unit: u\nSyndication-Action: withdraw\nSyndication-Expect: later\n') as { problem: string }).problem, /Expect/);
});

test('a foreign copy anywhere inside the unit makes it foreign, native content notwithstanding', () => {
  assert.deepEqual(unitStateFrom({ rootOrigin: undefined, insideOrigins: [null, 'other-wiki'], digest: '', name: 'v' }), { kind: 'foreign', wiki: 'other-wiki' });
  assert.deepEqual(unitStateFrom({ rootOrigin: undefined, insideOrigins: [null], digest: '', name: 'v' }), { kind: 'native' });
  assert.deepEqual(unitStateFrom({ rootOrigin: undefined, insideOrigins: ['v'], digest: '', name: 'v' }), { kind: 'absent' });
  assert.deepEqual(unitStateFrom({ rootOrigin: undefined, insideOrigins: [], digest: '', name: 'v' }), { kind: 'absent' });
  assert.deepEqual(unitStateFrom({ rootOrigin: null, insideOrigins: ['other'], digest: '', name: 'v' }), { kind: 'foreign', wiki: 'other' });
});
