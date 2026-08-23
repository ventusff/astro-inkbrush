import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runClaudeJob, type ClaudeJobOptions } from '../src/wiki/server/claude-process.ts';

/** a fake claude bin printing `lines` (stream-json), then running `tail` */
function fakeBin(dir: string, body: string): string {
  const bin = join(dir, 'fake-claude');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}`);
  chmodSync(bin, 0o755);
  return bin;
}

const RESULT_LINE = JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's1' });

function jobOpts(bin: string, dir: string, extra: Partial<ClaudeJobOptions> = {}): ClaudeJobOptions {
  return {
    bin,
    model: null,
    prompt: 'p',
    mode: 'readonly',
    cwd: dir,
    timeoutMs: 10_000,
    killOnDisconnect: false,
    onEvent: () => undefined,
    clientClosed: new AbortController().signal,
    ...extra,
  };
}

test('the promise settles only when the child closes, not at the result line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-claude-'));
  // the child prints its result, then keeps living (and could keep writing)
  // for 300ms before exiting
  const bin = fakeBin(
    dir,
    `console.log('${RESULT_LINE.replace(/'/g, "\\'")}');\nsetTimeout(() => process.exit(0), 300);`,
  );
  const started = Date.now();
  const result = await runClaudeJob(jobOpts(bin, dir));
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { ok: true, summary: 'done', sessionId: 's1' });
  assert.ok(elapsed >= 250, `resolved after ${elapsed}ms — before the child closed`);
  rmSync(dir, { recursive: true, force: true });
});

test('timeout escalates SIGTERM → SIGKILL and still waits for close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-claude-'));
  // the child ignores SIGTERM, so only the SIGKILL escalation ends it
  const bin = fakeBin(dir, `process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);`);
  const result = await runClaudeJob(jobOpts(bin, dir, { timeoutMs: 200, killGraceMs: 300 }));
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /timed out/);
  rmSync(dir, { recursive: true, force: true });
});

test('a client disconnect terminates the job with its own message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-claude-'));
  const bin = fakeBin(dir, `setInterval(() => {}, 1000);`);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  const result = await runClaudeJob(
    jobOpts(bin, dir, { killOnDisconnect: true, clientClosed: abort.signal, timeoutMs: 10_000 }),
  );
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /disconnected/);
  rmSync(dir, { recursive: true, force: true });
});

test('a bin that cannot be spawned reports a start failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-claude-'));
  const result = await runClaudeJob(jobOpts(join(dir, 'does-not-exist'), dir, { timeoutMs: 2000 }));
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /Could not start the claude CLI/);
  rmSync(dir, { recursive: true, force: true });
});
