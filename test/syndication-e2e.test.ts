/**
 * Syndication end to end, in process: an origin wiki (a project root with
 * notes) publishes a unit to a peer whose content repository is a bare
 * git remote; the peer's gate script runs in a checkout of that remote
 * as the peer's CI would; the origin derives every state from the
 * remote's refs.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { SyndicationPeer } from '../src/wiki/config.ts';
import { setConfigInput } from '../src/wiki/server/config.ts';
import { setSiteHooks } from '../src/wiki/server/site.ts';
import { setProjectRoot } from '../src/wiki/server/store.ts';
import { digest } from '../src/lib/syndication-bundle.ts';
import { buildTree, commitTree, push, revParse, writeBlobs } from '../src/lib/syndication-git.ts';
import { submissionMessage } from '../src/lib/syndication-state.ts';
import { mirrorDir } from '../src/wiki/server/syndication-peer.ts';
import { awaitVerdict, noteUnit, publishStream, setOverrides, submitPublish, submitWithdraw, SyndicationError, unitStatus } from '../src/wiki/server/syndication.ts';
import type { SyndicationStreamEvent } from '../src/wiki/shared/types.ts';

const execFileP = promisify(execFile);
const gate = resolve(import.meta.dirname, '..', 'scripts', 'syndication-gate.mjs');

const base = mkdtempSync(join(tmpdir(), 'inkbrush-syndication-'));
const remote = join(base, 'peer.git');
const peerWork = join(base, 'peer-work');
const root = join(base, 'origin');
const notes = join(root, 'src', 'content', 'notes');
const user = { name: 'Ada', email: 'ada@example.com' };
after(() => rmSync(base, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Peer Bot',
  GIT_AUTHOR_EMAIL: 'bot@peer.example',
  GIT_COMMITTER_NAME: 'Peer Bot',
  GIT_COMMITTER_EMAIL: 'bot@peer.example',
  GIT_TERMINAL_PROMPT: '0',
};
const peerGit = async (...args: string[]): Promise<string> => (await execFileP('git', args, { cwd: peerWork, env: gitEnv })).stdout.trim();

function write(files: Record<string, string>, at = notes): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(at, rel, '..'), { recursive: true });
    writeFileSync(join(at, rel), text);
  }
}

/** the peer's checkout at the pushed staging branch, then the gate as its CI runs it */
async function runGate(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [gate, ...args], { cwd: peerWork, env: gitEnv });
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: (e.stdout ?? '').trim(), stderr: e.stderr ?? '' };
  }
}

/** the peer's CI checkout: its own main, never the pushed branch — the
 *  staged sha is learned from the remote's refs and the gate fetches the
 *  commit itself */
async function checkoutStaged(branch: string): Promise<string> {
  const sha = (await peerGit('ls-remote', 'origin', `refs/heads/${branch}`)).split('\t')[0]!;
  assert.match(sha, /^[0-9a-f]{40}$/, `no staging branch ${branch}`);
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  return sha;
}

const ORIGINS = ['--origins', 'vortex,another-wiki'];

/** prepare → (the peer's checks pass) → finish --ok, as the workflow does */
async function accept(branch: string): Promise<void> {
  const staged = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', staged, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.match(prepared.stdout, /^[0-9a-f]{40}$/);
  assert.equal(await peerGit('rev-parse', 'HEAD'), prepared.stdout);
  const finished = await runGate('finish', '--branch', branch, '--staged', staged, '--promoted', prepared.stdout, ...ORIGINS, '--ok');
  assert.equal(finished.code, 0, finished.stderr);
}

const peer: SyndicationPeer = {
  id: 'chaser',
  title: 'Chaser Wiki',
  repo: remote,
  branch: 'main',
  contentDir: '',
  url: 'https://chaser.example/wiki/{id}/',
  locales: ['', 'en/', 'de/'],
  map: { domains: { ai: 'llm', internal: null } },
};

const never = new AbortController().signal;

test('setup: a peer repository with a note of its own, and an origin wiki', async () => {
  await execFileP('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileP('git', ['clone', '-q', remote, peerWork]);
  write(
    {
      'native-note/index.md': '---\ntitle: Native\n---\n\nthe peer wrote this\n',
      '_meta/schema.ts': 'export const x = 1;\n',
    },
    peerWork,
  );
  await peerGit('add', '-A');
  await peerGit('commit', '-q', '-m', 'peer: initial notes');
  await peerGit('push', '-q', 'origin', 'main');

  write({
    'chasing/index.mdx': '---\ntitle: Chasing\nkind: essay\ndomains: [ai, internal, robotics]\n---\n\nSee [[chasing/attention]] and [[Elsewhere]].\n',
    'chasing/attention/index.mdx': '---\ntitle: Attention\n---\n\nsub-page\n',
    'chasing/demo.ts': 'export default function mount() {}\n',
    'en/chasing/index.mdx': '---\ntitle: Chasing (en)\n---\n\nEnglish mirror\n',
    'elsewhere/index.md': '---\ntitle: Elsewhere\n---\n\nnot published\n',
    'native-note/index.md': '---\ntitle: Native (ours)\n---\n\nthe origin wrote this\n',
    'never/index.md': '---\ntitle: Never\nsyndication: false\n---\n\nstays home\n',
  });
  setProjectRoot(root);
  setSiteHooks(undefined);
  setConfigInput({ syndication: { name: 'vortex', peers: [{ ...peer, locales: [...peer.locales] }] } });
});

let revision = '';

test('a first publish: absent → pending → accepted by the gate → current', async () => {
  const before = await unitStatus(peer, 'chasing', 0);
  assert.equal(before.state, 'ready');
  assert.equal(before.copy, 'absent');
  assert.equal(before.plan?.notes, 3);
  assert.equal(before.plan?.files, 4);
  assert.deepEqual(before.plan?.fields, { kind: 'essay', domains: ['llm', 'robotics'] });
  assert.deepEqual(before.plan?.degraded, [{ note: 'chasing', target: 'Elsewhere', shown: 'Elsewhere' }]);

  const stages: string[] = [];
  const staged = (await submitPublish(peer, 'chasing', user, {}, (stage) => stages.push(stage)))!;
  assert.deepEqual(stages, ['fetching', 'preparing', 'checking', 'submitting']);
  assert.match(staged.revision, /^[0-9a-f]{16}$/);
  revision = staged.revision;

  const pending = await unitStatus(peer, 'chasing', 0);
  assert.equal(pending.copy, 'absent');
  assert.equal(pending.submission?.state, 'pending');
  assert.equal(pending.submission?.action, 'publish');
  assert.equal(pending.submission?.revision, revision);

  await accept('syndicate/vortex/chasing');
  const status = await awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision }, never);
  assert.equal(status.copy, 'current');
  assert.equal(status.behind, false);
  assert.equal(status.revision, revision);
  assert.equal(status.copyUrl, 'https://chaser.example/wiki/chasing/');
  assert.equal(status.submission, undefined);

  // the copy on the peer's main: transformed, stamped last, attributed to the author
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  const copy = readFileSync(join(peerWork, 'chasing', 'index.mdx'), 'utf8');
  assert.equal(
    copy,
    `---\ntitle: Chasing\nkind: essay\ndomains: [llm, robotics]\norigin:\n  wiki: vortex\n  revision: ${revision}\n  synced: ${staged.synced}\n---\n\nSee [[chasing/attention]] and Elsewhere.\n`,
  );
  assert.ok(readFileSync(join(peerWork, 'en', 'chasing', 'index.mdx'), 'utf8').includes('origin:\n  wiki: vortex'));
  assert.equal(readFileSync(join(peerWork, 'chasing', 'demo.ts'), 'utf8'), 'export default function mount() {}\n');
  assert.equal(await peerGit('log', '-1', '--format=%an <%ae>'), 'Ada <ada@example.com>');
  assert.equal(await peerGit('log', '-1', '--format=%s'), `wiki: chasing synced from vortex (${revision})`);
  assert.equal(await peerGit('ls-remote', '--heads', 'origin', 'syndicate/vortex/chasing'), '');
});

test('an edit at the origin: behind → publish → current', async () => {
  write({ 'chasing/attention/index.mdx': '---\ntitle: Attention\n---\n\nsub-page, revised\n' });
  const behind = await unitStatus(peer, 'chasing', 0);
  assert.equal(behind.copy, 'behind');
  assert.equal(behind.behind, true);

  const staged = (await submitPublish(peer, 'chasing', user, {}))!;
  assert.notEqual(staged.revision, revision);
  await accept('syndicate/vortex/chasing');
  const status = await awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision: staged.revision }, never);
  assert.equal(status.copy, 'current');
  revision = staged.revision;
});

test('finish --ok pushes nothing unchecked: a moved tip exits 3 and the workflow prepares again', async () => {
  write({ 'chasing/demo.ts': 'export default function mount() { /* v2 */ }\n' });
  const staged = (await submitPublish(peer, 'chasing', user, {}))!;
  const branch = 'syndicate/vortex/chasing';
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  // the peer commits something unrelated meanwhile
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  write({ 'native-note/index.md': '---\ntitle: Native\n---\n\nthe peer wrote this, then revised it\n' }, peerWork);
  await peerGit('commit', '-q', '-am', 'peer: revise the native note');
  await peerGit('push', '-q', 'origin', 'main');
  const moved = await peerGit('rev-parse', 'main');
  await peerGit('checkout', '-q', '--detach', prepared.stdout);
  const refused = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', prepared.stdout, ...ORIGINS, '--ok');
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(await peerGit('ls-remote', 'origin', 'refs/heads/main').then((l) => l.split('\t')[0]), moved);
  // the workflow's next round: prepare on the new tip, checks, finish
  const again = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(again.code, 0, again.stderr);
  assert.notEqual(again.stdout, prepared.stdout);
  const finished = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', again.stdout, ...ORIGINS, '--ok');
  assert.equal(finished.code, 0, finished.stderr);
  const status = await awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision: staged.revision }, never);
  assert.equal(status.copy, 'current');
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  assert.ok(readFileSync(join(peerWork, 'native-note', 'index.md'), 'utf8').includes('then revised it'));
  assert.ok(readFileSync(join(peerWork, 'chasing', 'demo.ts'), 'utf8').includes('v2'));
  assert.equal(await peerGit('log', '-1', '--format=%s'), `wiki: chasing synced from vortex (${staged.revision})`);
  revision = staged.revision;
});

test('the gate refuses a staged commit that touches paths outside the unit', async () => {
  // a hand-made submission: the unit's files plus a file the unit does not own
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const blobs = await writeBlobs(
    dir,
    new Map([
      ['chasing/index.mdx', new TextEncoder().encode(`---\ntitle: Chasing\norigin:\n  wiki: vortex\n  revision: ${revision}\n  synced: 2026-01-01T00:00:00Z\n---\n\nx\n`)],
      ['_meta/extra.ts', new TextEncoder().encode('export const smuggled = true;\n')],
    ]),
    join(base, 'scratch'),
  );
  const tree = await buildTree(dir, { base: tip, remove: ['chasing', 'en/chasing', 'de/chasing'], add: [...blobs].map(([path, sha]) => ({ path, sha })), indexFile: join(dir, 'idx') });
  const commit = await commitTree(dir, {
    tree,
    parents: [tip],
    message: submissionMessage({ origin: 'vortex', unit: 'chasing', action: 'publish', expect: { revision }, revision, force: false }),
    author: user,
    committer: user,
  });
  const branch = 'syndicate/vortex/chasing';
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 2);
  assert.match(prepared.stderr, /outside the unit's directories: _meta\/extra\.ts/);
  const status = await unitStatus(peer, 'chasing', 0);
  assert.equal(status.copy, 'current');
  assert.equal(status.submission?.state, 'rejected');
  assert.match(status.submission?.problems?.[0] ?? '', /_meta\/extra\.ts/);
});

test('a rejected submission: the gate refuses, the origin reads the verdict', async () => {
  write({ 'chasing/index.mdx': '---\ntitle: Chasing\nkind: essay\ndomains: [ai, internal, robotics]\n---\n\nSee [[chasing/attention]] and [[Elsewhere]], revised.\n' });
  const staged = (await submitPublish(peer, 'chasing', user, {}))!;
  const branch = 'syndicate/vortex/chasing';
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  writeFileSync(join(base, 'checks.log'), 'chasing/index.mdx:7:1 something the peer dislikes\nsecond line\n');
  const finished = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', prepared.stdout, ...ORIGINS, '--fail', '--problems', join(base, 'checks.log'));
  assert.equal(finished.code, 0, finished.stderr);

  await assert.rejects(
    awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision: staged.revision }, never),
    (err: unknown) =>
      err instanceof SyndicationError &&
      err.code === 'rejected' &&
      JSON.stringify(err.problems) === JSON.stringify(['chasing/index.mdx:7:1 something the peer dislikes', 'second line']),
  );
  const status = await unitStatus(peer, 'chasing', 0);
  assert.equal(status.copy, 'behind');
  assert.equal(status.revision, revision);
  assert.equal(status.submission?.state, 'rejected');
  assert.equal(status.submission?.revision, staged.revision);
  assert.deepEqual(status.submission?.problems, ['chasing/index.mdx:7:1 something the peer dislikes', 'second line']);

  // publishing again clears the verdict once accepted
  const again = (await submitPublish(peer, 'chasing', user, {}))!;
  await accept(branch);
  const after = await awaitVerdict(peer, 'chasing', { commit: again.commit, action: 'publish', revision: again.revision }, never);
  assert.equal(after.copy, 'current');
  assert.equal(after.submission, undefined);
  revision = again.revision;
});

test('a copy changed on the peer: changed → force publish → current; the gate refuses a stale expectation', async () => {
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  writeFileSync(join(peerWork, 'chasing', 'index.mdx'), readFileSync(join(peerWork, 'chasing', 'index.mdx'), 'utf8') + '\nedited on the peer\n');
  await peerGit('commit', '-q', '-am', 'peer: touch the copy');
  await peerGit('push', '-q', 'origin', 'main');

  const changed = await unitStatus(peer, 'chasing', 0);
  assert.equal(changed.copy, 'changed');
  assert.equal(changed.behind, false);
  await assert.rejects(submitPublish(peer, 'chasing', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'changed');

  const staged = (await submitPublish(peer, 'chasing', user, { force: true }))!;
  await accept('syndicate/vortex/chasing');
  const status = await awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision: staged.revision }, never);
  assert.equal(status.copy, 'current');
  assert.equal(status.revision, revision);
});

test('the gate re-decides on the current tip: a submission expecting an older revision is refused as moved', async () => {
  // stage a publish, then move the peer's copy under it before the gate runs
  const staged = (await submitPublish(peer, 'chasing', user, { force: true }))!;
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  const text = readFileSync(join(peerWork, 'chasing', 'index.mdx'), 'utf8');
  writeFileSync(join(peerWork, 'chasing', 'index.mdx'), text.replace(/revision: [0-9a-f]{16}/, 'revision: abcdefabcdefabcd'));
  await peerGit('commit', '-q', '-am', 'peer: re-stamp the copy');
  await peerGit('push', '-q', 'origin', 'main');

  const branch = 'syndicate/vortex/chasing';
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 2);
  assert.match(prepared.stderr, /refused: .*revision abcdefabcdefabcd/);
  await assert.rejects(
    awaitVerdict(peer, 'chasing', { commit: staged.commit, action: 'publish', revision: staged.revision }, never),
    (err: unknown) => err instanceof SyndicationError && err.code === 'rejected',
  );
  const status = await unitStatus(peer, 'chasing', 0);
  assert.equal(status.submission?.code, 'moved');

  // restore the stamp so the copy is intact again
  await peerGit('checkout', '-q', 'main');
  writeFileSync(join(peerWork, 'chasing', 'index.mdx'), text);
  await peerGit('commit', '-q', '-am', 'peer: restore the stamp');
  await peerGit('push', '-q', 'origin', 'main');
  assert.equal((await unitStatus(peer, 'chasing', 0)).copy, 'current');
});

test('withdraw: pending → accepted → absent', async () => {
  await submitWithdraw(peer, 'chasing', user, {});
  const pending = await unitStatus(peer, 'chasing', 0);
  assert.equal(pending.copy, 'current');
  assert.equal(pending.submission?.action, 'withdraw');
  assert.equal(pending.submission?.state, 'pending');
  await assert.rejects(submitPublish(peer, 'chasing', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'pending');

  await accept('syndicate/vortex/chasing');
  const status = await unitStatus(peer, 'chasing', 0);
  assert.equal(status.copy, 'absent');
  assert.equal(status.submission, undefined);
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  assert.equal(await peerGit('ls-tree', '-r', '--name-only', 'HEAD', '--', 'chasing', 'en/chasing'), '');
  assert.equal(await peerGit('log', '-1', '--format=%s'), 'wiki: chasing withdrawn by vortex');
  await assert.rejects(submitWithdraw(peer, 'chasing', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'gone');
});

test('adopting a native note of the peer requires adopt', async () => {
  const occupied = await unitStatus(peer, 'native-note', 0);
  assert.equal(occupied.copy, 'occupied');
  await assert.rejects(submitPublish(peer, 'native-note', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'native');
  const staged = (await submitPublish(peer, 'native-note', user, { adopt: true }))!;
  await accept('syndicate/vortex/native-note');
  const status = await awaitVerdict(peer, 'native-note', { commit: staged.commit, action: 'publish', revision: staged.revision }, never);
  assert.equal(status.copy, 'current');
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  assert.ok(readFileSync(join(peerWork, 'native-note', 'index.md'), 'utf8').includes('the origin wrote this'));
});

test('refusals: syndication false; an unreachable peer; overrides change the plan', async () => {
  const never = await unitStatus(peer, 'never', 0);
  assert.deepEqual(never.refusals, [{ code: 'never', note: 'never' }]);
  assert.equal(never.plan, undefined);
  await assert.rejects(submitPublish(peer, 'never', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'refused');

  const gone = await unitStatus({ ...peer, id: 'gone', repo: join(base, 'no-such.git') }, 'chasing', 0);
  assert.equal(gone.state, 'unreachable');
  assert.equal(gone.copy, null);
  assert.ok(gone.error);

  await setOverrides('chasing', peer, { kind: 'article', tags: ['mirror'] }, user);
  const source = readFileSync(join(notes, 'chasing', 'index.mdx'), 'utf8');
  assert.ok(source.includes('syndication:\n  chaser:\n    kind: article\n    tags: [mirror]\n'));
  const status = await unitStatus(peer, 'chasing', 0);
  assert.deepEqual(status.plan?.fields, { kind: 'article', domains: ['llm', 'robotics'], tags: ['mirror'] });
  assert.deepEqual(status.plan?.overrides, { kind: 'article', tags: ['mirror'] });
  await setOverrides('chasing', peer, null, user);
  assert.ok(!readFileSync(join(notes, 'chasing', 'index.mdx'), 'utf8').includes('syndication'));
});

/* ---------------- what the origin decides from the peer's refs ---------------- */

test('publishing a current copy pushes nothing', async () => {
  assert.equal((await unitStatus(peer, 'native-note', 0)).copy, 'current');
  assert.equal(await submitPublish(peer, 'native-note', user, {}), null);
  assert.equal(await peerGit('ls-remote', '--heads', 'origin', 'syndicate/vortex/native-note'), '');
});

test('a forced republish of the same revision is accepted only once the gate promoted it', async () => {
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  writeFileSync(join(peerWork, 'native-note', 'index.md'), readFileSync(join(peerWork, 'native-note', 'index.md'), 'utf8') + '\nedited on the peer\n');
  await peerGit('commit', '-q', '-am', 'peer: touch the copy again');
  await peerGit('push', '-q', 'origin', 'main');
  assert.equal((await unitStatus(peer, 'native-note', 0)).copy, 'changed');
  const staged = (await submitPublish(peer, 'native-note', user, { force: true }))!;
  const before = await awaitVerdict(peer, 'native-note', { commit: staged.commit, action: 'publish', revision: staged.revision }, never, undefined, { waitMs: 0 });
  assert.equal(before.copy, 'changed');
  assert.equal(before.submission?.state, 'pending');
  await accept('syndicate/vortex/native-note');
  const after = await awaitVerdict(peer, 'native-note', { commit: staged.commit, action: 'publish', revision: staged.revision }, never);
  assert.equal(after.copy, 'current');
  assert.equal(after.submission, undefined);
});

test("a peer's own note inside a unit's directories occupies the unit even without a root note", async () => {
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  write({ 'guide/docs/index.md': '---\ntitle: Guide docs\n---\n\npeer-owned\n' }, peerWork);
  await peerGit('add', '-A');
  await peerGit('commit', '-q', '-m', 'peer: a nested note of its own');
  await peerGit('push', '-q', 'origin', 'main');
  write({ 'guide/index.md': '---\ntitle: Guide\n---\n\nours\n' });
  assert.equal((await unitStatus(peer, 'guide', 0)).copy, 'occupied');
  await assert.rejects(submitPublish(peer, 'guide', user, {}), (err: unknown) => err instanceof SyndicationError && err.code === 'native');
});

test('the peer reading is keyed by the origin name and the transform by every input', async () => {
  setConfigInput({ syndication: { name: 'someone-else', peers: [{ ...peer, locales: [...peer.locales] }] } });
  try {
    assert.equal((await unitStatus(peer, 'native-note', 0)).copy, 'foreign');
  } finally {
    setConfigInput({ syndication: { name: 'vortex', peers: [{ ...peer, locales: [...peer.locales] }] } });
  }
  assert.equal((await unitStatus(peer, 'native-note', 0)).copy, 'current');

  write({ 'links/index.md': '---\ntitle: Links\n---\n\n[read](/wiki/elsewhere/)\n' });
  assert.deepEqual((await unitStatus(peer, 'links', 0)).plan?.degraded, []);
  setSiteHooks({ urlFor: (id) => `/wiki/${id}/` });
  try {
    assert.deepEqual((await unitStatus(peer, 'links', 0)).plan?.degraded, [{ note: 'links', target: '/wiki/elsewhere/', shown: 'read' }]);
  } finally {
    setSiteHooks(undefined);
  }
});

test('a unit that no longer exists here can still be withdrawn', async () => {
  rmSync(join(notes, 'native-note'), { recursive: true });
  assert.equal(existsSync(join(notes, 'native-note')), false);
  assert.throws(() => noteUnit('native-note', true), (err: unknown) => (err as { status?: number }).status === 404);
  assert.equal(noteUnit('native-note', false), 'native-note');
  assert.throws(() => noteUnit('_meta', false), (err: unknown) => (err as { status?: number }).status === 400);
  await submitWithdraw(peer, 'native-note', user, {});
  await accept('syndicate/vortex/native-note');
  assert.equal((await unitStatus(peer, 'native-note', 0)).copy, 'absent');
});

test('a mirror path that is not a bare repository is refused, never searched upward', async () => {
  const plain = { ...peer, id: 'plain' };
  mkdirSync(join(root, '.wiki', 'data', 'syndication', 'plain.git'), { recursive: true });
  const status = await unitStatus(plain, 'chasing', 0);
  assert.equal(status.state, 'unreachable');
  assert.match(status.error ?? '', /bare repository/);
});

/* ---------------- the gate's trust boundary ---------------- */

test('the gate runs only with an origin allowlist, and refuses an unknown origin without recording anything', async () => {
  const branch = 'syndicate/stranger/chasing';
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const commit = await commitTree(dir, {
    tree: await buildTree(dir, { base: tip, remove: [], add: [], indexFile: join(dir, 'idx') }),
    parents: [tip],
    message: submissionMessage({ origin: 'stranger', unit: 'chasing', action: 'withdraw', expect: 'none', force: false }),
    author: user,
    committer: user,
  });
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  const stagedSha = await checkoutStaged(branch);
  const without = await runGate('prepare', '--branch', branch, '--staged', stagedSha);
  assert.equal(without.code, 1);
  assert.match(without.stderr, /--origins/);
  const unknown = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /not a wiki this repository accepts/);
  await assert.rejects(peerGit('ls-remote', '--exit-code', 'origin', 'refs/heads/syndication-verdicts').then(() => peerGit('fetch', '-q', 'origin', 'syndication-verdicts')).then(() => peerGit('cat-file', '-e', 'FETCH_HEAD:stranger/chasing.json')));
  assert.notEqual(await peerGit('ls-remote', 'origin', `refs/heads/${branch}`), '');
  await peerGit('push', '-q', 'origin', '--delete', branch);
});

test('a reserved or locale directory is not a unit, at the origin and at the gate', async () => {
  assert.throws(() => noteUnit('en/x', false) && noteUnit('en', false), (err: unknown) => (err as { status?: number }).status === 400);
  for (const bad of ['_meta', 'docs', 'inbox', 'en']) {
    assert.throws(() => noteUnit(bad, false), (err: unknown) => (err as { status?: number }).status === 400, bad);
  }
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const blobs = await writeBlobs(dir, new Map([['_meta/index.md', new TextEncoder().encode('---\ntitle: x\norigin:\n  wiki: vortex\n  revision: abcdefabcdefabcd\n  synced: 2026-01-01T00:00:00Z\n---\n')]]), join(base, 'scratch2'));
  const commit = await commitTree(dir, {
    tree: await buildTree(dir, { base: tip, remove: [], add: [...blobs].map(([path, sha]) => ({ path, sha })), indexFile: join(dir, 'idx') }),
    parents: [tip],
    message: submissionMessage({ origin: 'vortex', unit: '_meta', action: 'publish', expect: 'none', revision: 'abcdefabcdefabcd', force: false }),
    author: user,
    committer: user,
  });
  const branch = 'syndicate/vortex/_meta';
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 2);
  assert.match(prepared.stderr, /reserved directory/);
  await peerGit('fetch', '-q', 'origin', 'syndication-verdicts');
  assert.equal(await peerGit('cat-file', '-t', 'FETCH_HEAD:vortex/_meta.json'), 'blob');
  assert.equal(await peerGit('ls-remote', 'origin', `refs/heads/${branch}`), '');
});

test('a submission replaced during the run is neither judged nor deleted', async () => {
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nfirst\n' });
  const first = (await submitPublish(peer, 'links', user, {}))!;
  const branch = 'syndicate/vortex/links';
  const stagedSha = await checkoutStaged(branch);
  assert.equal(stagedSha, first.commit);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  // the origin submits a newer version while the first is being checked
  await peerGit('push', '-q', 'origin', '--delete', branch);
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nsecond\n' });
  const second = (await submitPublish(peer, 'links', user, {}))!;
  assert.notEqual(second.commit, first.commit);
  writeFileSync(join(base, 'checks2.log'), 'the first version failed\n');
  const finished = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', prepared.stdout, ...ORIGINS, '--fail', '--problems', join(base, 'checks2.log'));
  assert.equal(finished.code, 0, finished.stderr);
  // the verdict names the first commit; the second submission still stands
  const status = await unitStatus(peer, 'links', 0);
  assert.equal(status.submission?.state, 'pending');
  assert.equal(status.submission?.revision, second.revision);
  await peerGit('fetch', '-q', 'origin', 'syndication-verdicts');
  const verdict = JSON.parse(await peerGit('show', 'FETCH_HEAD:vortex/links.json')) as { staged: string };
  assert.equal(verdict.staged, first.commit);
  await accept(branch);
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'current');
});

test('a submission with a symlink, a submodule or two root note files is refused; such a copy on the peer is changed input', async () => {
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const stamp = (rev: string): Uint8Array => new TextEncoder().encode(`---\ntitle: Links\norigin:\n  wiki: vortex\n  revision: ${rev}\n  synced: 2026-01-01T00:00:00Z\n---\n\nsecond\n`);
  const current = await unitStatus(peer, 'links', 0);
  assert.equal(current.copy, 'current');
  const revision = current.revision!;
  const blobs = await writeBlobs(dir, new Map([['links/index.md', stamp(revision)], ['links/leak.ts', new TextEncoder().encode('../../.wiki/secret')]]), join(base, 'scratch3'));
  const submit = async (add: Array<{ path: string; sha: string; mode?: string }>): Promise<string> => {
    const commit = await commitTree(dir, {
      tree: await buildTree(dir, { base: tip, remove: ['links', 'en/links', 'de/links'], add, indexFile: join(dir, 'idx') }),
      parents: [tip],
      message: submissionMessage({ origin: 'vortex', unit: 'links', action: 'publish', expect: { revision }, revision, force: true }),
      author: user,
      committer: user,
    });
    await push(dir, 'origin', `${commit}:refs/heads/syndicate/vortex/links`, true);
    return commit;
  };
  for (const [add, problem] of [
    [[{ path: 'links/index.md', sha: blobs.get('links/index.md')! }, { path: 'links/leak.ts', sha: blobs.get('links/leak.ts')!, mode: '120000' }], /not a regular file \(mode 120000\)/],
    [[{ path: 'links/index.md', sha: blobs.get('links/index.md')! }, { path: 'links/vendor', sha: 'b'.repeat(40), mode: '160000' }], /not a regular file \(mode 160000\)/],
    [[{ path: 'links/index.md', sha: blobs.get('links/index.md')! }, { path: 'links/index.mdx', sha: blobs.get('links/index.md')! }], /both index\.md and index\.mdx/],
    [[{ path: 'links/index.md', sha: blobs.get('links/index.md')! }, { path: 'links/.env', sha: blobs.get('links/leak.ts')! }], /dot-prefixed/],
  ] as Array<[Array<{ path: string; sha: string; mode?: string }>, RegExp]>) {
    const commit = await submit(add);
    await peerGit('fetch', '-q', 'origin');
    const prepared = await runGate('prepare', '--branch', 'syndicate/vortex/links', '--staged', commit, ...ORIGINS);
    assert.equal(prepared.code, 2, prepared.stderr);
    assert.match(prepared.stderr, problem);
  }
  // the peer itself holds a symlink inside the copy: the origin sees a changed copy, never a file
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  await peerGit('update-index', '--add', '--cacheinfo', `120000,${blobs.get('links/leak.ts')!},links/leak.ts`);
  await peerGit('commit', '-q', '-m', 'peer: a symlink in the copy');
  await peerGit('push', '-q', 'origin', 'main');
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'changed');
  await peerGit('rm', '-q', '--cached', 'links/leak.ts');
  await peerGit('commit', '-q', '-m', 'peer: symlink removed');
  await peerGit('push', '-q', 'origin', 'main');
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'current');
});

/* ---------------- the origin's caches, containment and pending refs ---------------- */

test('a mirror path that is a symlink is refused before any git command', async () => {
  const other = join(base, 'elsewhere.git');
  await execFileP('git', ['init', '-q', '--bare', other]);
  const { symlinkSync } = await import('node:fs');
  symlinkSync(other, join(root, '.wiki', 'data', 'syndication', 'linked.git'));
  const status = await unitStatus({ ...peer, id: 'linked' }, 'chasing', 0);
  assert.equal(status.state, 'unreachable');
  assert.match(status.error ?? '', /symlink/);
  assert.equal((await execFileP('git', ['--git-dir', other, 'remote'])).stdout.trim(), '');
});

test('the transform cache sees a URL rule that changes for one note only', async () => {
  write({ 'links/index.md': '---\ntitle: Links\n---\n\n[read](/wiki/elsewhere/)\n' });
  assert.deepEqual((await unitStatus(peer, 'links', 0)).plan?.degraded, []);
  setSiteHooks({ urlFor: (id) => (id === 'elsewhere' ? '/wiki/elsewhere/' : `/${id}/`) });
  try {
    assert.deepEqual((await unitStatus(peer, 'links', 0)).plan?.degraded, [{ note: 'links', target: '/wiki/elsewhere/', shown: 'read' }]);
  } finally {
    setSiteHooks(undefined);
  }
  assert.deepEqual((await unitStatus(peer, 'links', 0)).plan?.degraded, []);
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nsecond\n' });
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'current');
});

test('fetch freshness belongs to the configuration the mirror was last fetched for', async () => {
  const other = join(base, 'other-peer.git');
  await execFileP('git', ['init', '-q', '--bare', '-b', 'main', other]);
  const work = join(base, 'other-work');
  await execFileP('git', ['clone', '-q', other, work]);
  write({ 'unrelated/index.md': '---\ntitle: Unrelated\n---\n\nx\n' }, work);
  await execFileP('git', ['add', '-A'], { cwd: work, env: gitEnv });
  await execFileP('git', ['commit', '-q', '-m', 'other peer'], { cwd: work, env: gitEnv });
  await execFileP('git', ['push', '-q', 'origin', 'main'], { cwd: work, env: gitEnv });
  const same = { ...peer };
  const swapped = { ...peer, repo: other };
  assert.equal((await unitStatus(same, 'links', 15_000)).copy, 'current');
  assert.equal((await unitStatus(swapped, 'links', 15_000)).copy, 'absent');
  // back within the freshness window: the mirror holds the other repository's refs, so it must fetch again
  assert.equal((await unitStatus(same, 'links', 15_000)).copy, 'current');
});

test('a staging branch whose commit says nothing readable is still a pending submission', async () => {
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const commit = await commitTree(dir, { tree: await buildTree(dir, { base: tip, remove: [], add: [], indexFile: join(dir, 'idx') }), parents: [tip], message: 'not a submission\n', author: user, committer: user });
  const branch = 'syndicate/vortex/links';
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  const status = await unitStatus(peer, 'links', 0);
  assert.equal(status.copy, 'current');
  assert.equal(status.submission?.state, 'pending');
  await assert.rejects(submitPublish(peer, 'links', user, { force: true }), (err: unknown) => err instanceof SyndicationError && err.code === 'pending');
  const waited = await awaitVerdict(peer, 'links', { commit, action: 'publish', revision: status.revision }, never, undefined, { waitMs: 0 });
  assert.equal(waited.submission?.state, 'pending');
  await peerGit('push', '-q', 'origin', '--delete', branch);
  // (a verdict from an earlier refusal of this unit still stands: not pending any more)
  assert.notEqual((await unitStatus(peer, 'links', 0)).submission?.state, 'pending');
});

test('the gate reads the submission as git objects: a fresh checkout of main never holds the pushed commit', async () => {
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nthird\n' });
  const staged = (await submitPublish(peer, 'links', user, {}))!;
  const fresh = join(base, 'fresh-checkout');
  // through the transport (a local-path clone copies every object of the remote)
  await execFileP('git', ['clone', '-q', '--single-branch', '--branch', 'main', pathToFileURL(remote).href, fresh]);
  const freshGit = async (...args: string[]): Promise<string> => (await execFileP('git', args, { cwd: fresh, env: gitEnv })).stdout.trim();
  await assert.rejects(freshGit('cat-file', '-e', `${staged.commit}^{commit}`));
  const branch = 'syndicate/vortex/links';
  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileP(process.execPath, [gate, ...args], { cwd: fresh, env: gitEnv });
      return { code: 0, stdout: stdout.trim(), stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: (e.stdout ?? '').trim(), stderr: e.stderr ?? '' };
    }
  };
  const prepared = await run('prepare', '--branch', branch, '--staged', staged.commit, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  // the pushed commit is an object now, the working tree is the promoted commit, never the pushed one
  assert.equal(await freshGit('cat-file', '-t', staged.commit), 'commit');
  assert.equal(await freshGit('rev-parse', 'HEAD'), prepared.stdout);
  assert.notEqual(prepared.stdout, staged.commit);
  assert.equal(await freshGit('branch', '--show-current'), '');
  const finished = await run('finish', '--branch', branch, '--staged', staged.commit, '--promoted', prepared.stdout, ...ORIGINS, '--ok');
  assert.equal(finished.code, 0, finished.stderr);
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'current');
});

/* ---------------- submission identity, verdict lifecycle, unit boundaries ---------------- */

test('a submission is identified by its staged commit, and the publish stream says when it was submitted', async () => {
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nfourth\n' });
  const events: SyndicationStreamEvent[] = [];
  await publishStream(peer, 'links', user, {}, (e) => events.push(e), never, { waitMs: 0 });
  const submitted = events.find((e) => e.kind === 'submitted') as { commit: string; revision: string } | undefined;
  assert.ok(submitted, JSON.stringify(events));
  assert.match(submitted.commit, /^[0-9a-f]{40}$/);
  const stages = events.filter((e) => e.kind === 'progress').map((e) => (e as { stage: string }).stage);
  assert.deepEqual(stages.slice(0, 4), ['fetching', 'preparing', 'checking', 'submitting']);
  assert.ok(events.indexOf(submitted as SyndicationStreamEvent) < events.findIndex((e) => e.kind === 'result'));
  const result = events[events.length - 1] as { kind: string; status: { submission?: { state: string; commit: string } } };
  assert.equal(result.kind, 'result');
  assert.equal(result.status.submission?.state, 'pending');
  assert.equal(result.status.submission?.commit, submitted.commit);
  // refused by the gate: the rejection names the same commit
  const branch = 'syndicate/vortex/links';
  const stagedSha = await checkoutStaged(branch);
  assert.equal(stagedSha, submitted.commit);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  writeFileSync(join(base, 'checks3.log'), 'nope\n');
  const finished = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', prepared.stdout, ...ORIGINS, '--fail', '--problems', join(base, 'checks3.log'));
  assert.equal(finished.code, 0, finished.stderr);
  const status = await unitStatus(peer, 'links', 0);
  assert.equal(status.submission?.state, 'rejected');
  assert.equal(status.submission?.commit, submitted.commit);
  // a withdrawal answers with the pending submission and its commit
  const withdrawn = await submitWithdraw(peer, 'links', user, {});
  const pending = await unitStatus(peer, 'links', 0);
  assert.equal(pending.submission?.state, 'pending');
  assert.equal(pending.submission?.commit, withdrawn);
  await accept(branch);
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'absent');
});

test('a unit whose root path is a file on the peer is refused, at the origin and at the gate', async () => {
  await peerGit('checkout', '-q', 'main');
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  write({ 'README.md': '# the peer\n' }, peerWork);
  await peerGit('add', '-A');
  await peerGit('commit', '-q', '-m', 'peer: a readme');
  await peerGit('push', '-q', 'origin', 'main');
  write({ 'README.md/index.md': '---\ntitle: Readme unit\n---\n\nours\n' });
  const status = await unitStatus(peer, 'README.md', 0);
  assert.equal(status.copy, 'occupied');
  await assert.rejects(submitPublish(peer, 'README.md', user, { adopt: true }), (err: unknown) => err instanceof SyndicationError && err.code === 'native' && /file/.test(err.message));

  // a hand-made submission on a parent that lacks the file: the gate refuses it against the current tip
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const parent = await commitTree(dir, {
    tree: await buildTree(dir, { base: tip, remove: ['README.md'], add: [], indexFile: join(dir, 'idx') }),
    parents: [tip],
    message: 'sender: without the readme\n',
    author: user,
    committer: user,
  });
  const text = (revision: string): Uint8Array => new TextEncoder().encode(`---\ntitle: x\norigin:\n  wiki: vortex\n  revision: ${revision}\n  synced: 2026-01-01T00:00:00Z\n---\n`);
  const revision = digest(new Map([['README.md/index.md', text('0000000000000000')]]));
  const blobs = await writeBlobs(dir, new Map([['README.md/index.md', text(revision)]]), join(base, 'scratch4'));
  const commit = await commitTree(dir, {
    tree: await buildTree(dir, { base: parent, remove: [], add: [...blobs].map(([path, sha]) => ({ path, sha })), indexFile: join(dir, 'idx') }),
    parents: [parent],
    message: submissionMessage({ origin: 'vortex', unit: 'README.md', action: 'publish', expect: 'none', revision, force: false }),
    author: user,
    committer: user,
  });
  const branch = 'syndicate/vortex/README.md';
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', commit, ...ORIGINS);
  assert.equal(prepared.code, 2, prepared.stderr);
  assert.match(prepared.stderr, /README\.md.*file/);
  await peerGit('pull', '-q', '--ff-only', 'origin', 'main');
  assert.equal(readFileSync(join(peerWork, 'README.md'), 'utf8'), '# the peer\n');
});

test('a submission the gate cannot read (an alias flood) is refused with a verdict, never stranded', async () => {
  const flood = `---\na: &a [1]\nb: [${Array.from({ length: 150 }, () => '*a').join(', ')}]\ntitle: Flood\norigin:\n  wiki: vortex\n  revision: abcdefabcdefabcd\n  synced: 2026-01-01T00:00:00Z\n---\nbody\n`;
  const dir = mirrorDir(peer);
  const tip = await revParse(dir, 'refs/peer/base');
  const blobs = await writeBlobs(dir, new Map([['flood/index.md', new TextEncoder().encode(flood)]]), join(base, 'scratch5'));
  const commit = await commitTree(dir, {
    tree: await buildTree(dir, { base: tip, remove: [], add: [...blobs].map(([path, sha]) => ({ path, sha })), indexFile: join(dir, 'idx') }),
    parents: [tip],
    message: submissionMessage({ origin: 'vortex', unit: 'flood', action: 'publish', expect: 'none', revision: 'abcdefabcdefabcd', force: false }),
    author: user,
    committer: user,
  });
  const branch = 'syndicate/vortex/flood';
  await push(dir, 'origin', `${commit}:refs/heads/${branch}`, true);
  await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', commit, ...ORIGINS);
  assert.equal(prepared.code, 2, prepared.stderr);
  assert.equal(await peerGit('ls-remote', 'origin', `refs/heads/${branch}`), '');
  await peerGit('fetch', '-q', 'origin', 'syndication-verdicts');
  const verdict = JSON.parse(await peerGit('show', 'FETCH_HEAD:vortex/flood.json')) as { staged: string; problems: string[] };
  assert.equal(verdict.staged, commit);
  assert.match(verdict.problems[0] ?? '', /could not be read|alias|no origin block/i);
  // no such unit exists here, so nothing publishing would send matches the verdict: it answers nothing
  assert.equal((await unitStatus(peer, 'flood', 0)).submission, undefined);
});

test('verdicts live as files on the syndication-verdicts branch, removed by a promotion; no custom refs exist', async () => {
  const refs = await peerGit('ls-remote', 'origin');
  assert.doesNotMatch(refs, /refs\/syndication\//);
  assert.match(refs, /refs\/heads\/syndication-verdicts/);
  await peerGit('fetch', '-q', 'origin', 'syndication-verdicts');
  const listed = await peerGit('ls-tree', '-r', '--name-only', 'FETCH_HEAD');
  assert.ok(listed.split('\n').includes('vortex/flood.json'), listed);
  assert.ok(listed.split('\n').includes('vortex/README.md.json'), listed);
  // a fresh publish of a refused unit, accepted: its file goes away, the others stay
  write({ 'flood/index.md': '---\ntitle: Flood\n---\n\nfine now\n' });
  const staged = (await submitPublish(peer, 'flood', user, {}))!;
  await accept('syndicate/vortex/flood');
  assert.equal((await awaitVerdict(peer, 'flood', { commit: staged.commit, action: 'publish', revision: staged.revision }, never)).copy, 'current');
  await peerGit('fetch', '-q', 'origin', 'syndication-verdicts');
  const after = (await peerGit('ls-tree', '-r', '--name-only', 'FETCH_HEAD')).split('\n');
  assert.ok(!after.includes('vortex/flood.json'), after.join(','));
  assert.ok(after.includes('vortex/README.md.json'), after.join(','));
});

test('a rejection stands only while it is still the answer: a changed note makes a publish verdict moot', async () => {
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nfifth\n' });
  const staged = (await submitPublish(peer, 'links', user, {}))!;
  const branch = 'syndicate/vortex/links';
  const stagedSha = await checkoutStaged(branch);
  const prepared = await runGate('prepare', '--branch', branch, '--staged', stagedSha, ...ORIGINS);
  assert.equal(prepared.code, 0, prepared.stderr);
  writeFileSync(join(base, 'checks4.log'), 'not this one\n');
  const finished = await runGate('finish', '--branch', branch, '--staged', stagedSha, '--promoted', prepared.stdout, ...ORIGINS, '--fail', '--problems', join(base, 'checks4.log'));
  assert.equal(finished.code, 0, finished.stderr);
  const rejected = await unitStatus(peer, 'links', 0);
  assert.equal(rejected.submission?.state, 'rejected');
  assert.equal(rejected.submission?.commit, staged.commit);
  assert.equal(rejected.copy, 'absent');
  // the note changes: publishing now would send something else, the verdict answers nothing
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nsixth\n' });
  assert.equal((await unitStatus(peer, 'links', 0)).submission, undefined);
  // back to the refused content: the verdict is the answer again
  write({ 'links/index.md': '---\ntitle: Links\n---\n\nfifth\n' });
  assert.equal((await unitStatus(peer, 'links', 0)).submission?.state, 'rejected');
  // a withdraw verdict counts while the copy exists; there is no copy here, so a withdraw verdict would not
  await submitPublish(peer, 'links', user, {});
  await accept(branch);
  assert.equal((await unitStatus(peer, 'links', 0)).copy, 'current');
});
