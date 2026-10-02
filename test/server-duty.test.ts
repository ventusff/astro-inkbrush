/**
 * The duty verdict every background task asks before it runs: the site's
 * `onDuty` check when one is given, always on duty without one.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { setConfigInput } from '../src/wiki/server/config.ts';
import { onDuty, setDutyCheck } from '../src/wiki/server/duty.ts';
import { startInboxWatcher } from '../src/wiki/server/obsidian.ts';
import { setProjectRoot } from '../src/wiki/server/store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: string[] = [];
after(() => {
  setDutyCheck(undefined);
  setConfigInput(null);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('without a site check every process is on duty', () => {
  setDutyCheck(undefined);
  assert.equal(onDuty(), true);
});

test('the site check decides, asked anew each time', () => {
  let duty = false;
  setDutyCheck(() => duty);
  assert.equal(onDuty(), false);
  duty = true;
  assert.equal(onDuty(), true);
  setDutyCheck(undefined);
});

test('a check that throws counts as off duty', () => {
  setDutyCheck(() => {
    throw new Error('duty record unreadable');
  });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    assert.equal(onDuty(), false);
  } finally {
    console.error = original;
    setDutyCheck(undefined);
  }
  assert.equal(errors.length, 1);
});

test('the inbox watcher acts on its events only on duty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inkbrush-duty-'));
  dirs.push(root);
  const inbox = join(root, 'vault');
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'clip.md'), '# clip\n');
  const state = join(root, '.wiki', 'data', 'inbox-sync.json');
  setProjectRoot(root);
  setConfigInput({ inbox: { dir: inbox } });
  const log = console.log;
  console.log = () => undefined;
  try {
    // a file already in the vault is marked seen by the first event — off
    // duty that event is left to the process on duty
    setDutyCheck(() => false);
    let stop = startInboxWatcher();
    await sleep(1500);
    await stop();
    assert.equal(existsSync(state), false);

    setDutyCheck(() => true);
    stop = startInboxWatcher();
    await sleep(1500);
    await stop();
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(state, 'utf8'))), ['clip.md']);
  } finally {
    console.log = log;
    setDutyCheck(undefined);
  }
});
