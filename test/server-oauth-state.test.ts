import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  createSingleUse,
  decodeOAuthState,
  encodeOAuthState,
  OAUTH_STATE_TTL_MS,
} from '../src/wiki/server/oauth-state.ts';

const SECRET = 'test-secret';

test('a state round-trips within its lifetime', () => {
  const now = 1_700_000_000_000;
  const state = encodeOAuthState({ nonce: 'n1', returnTo: '/here', iat: now }, SECRET);
  const decoded = decodeOAuthState(state, SECRET, now + 60_000);
  assert.deepEqual(decoded, { nonce: 'n1', returnTo: '/here', iat: now });
});

test('an expired state is refused, right at the ten-minute boundary', () => {
  const now = 1_700_000_000_000;
  const state = encodeOAuthState({ nonce: 'n1', returnTo: '/', iat: now }, SECRET);
  assert.doesNotThrow(() => decodeOAuthState(state, SECRET, now + OAUTH_STATE_TTL_MS));
  assert.throws(() => decodeOAuthState(state, SECRET, now + OAUTH_STATE_TTL_MS + 1), /took too long/);
});

test('a tampered or unsigned state and a missing/future iat are refused', () => {
  const now = 1_700_000_000_000;
  const state = encodeOAuthState({ nonce: 'n1', returnTo: '/', iat: now }, SECRET);
  assert.throws(() => decodeOAuthState(`${state}x`, SECRET, now), /invalid/);
  assert.throws(() => decodeOAuthState(state, 'other-secret', now), /invalid/);
  assert.throws(() => decodeOAuthState('no-dot-here', SECRET, now), /invalid/);
  // a payload without iat (a pre-expiry token shape) is refused even with
  // a valid MAC
  const body = Buffer.from(JSON.stringify({ nonce: 'n1', returnTo: '/' })).toString('base64url');
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url');
  assert.throws(() => decodeOAuthState(`${body}.${mac}`, SECRET, now), /invalid/);
  // an iat far in the future is as invalid as an expired one
  const future = encodeOAuthState({ nonce: 'n1', returnTo: '/', iat: now + 3_600_000 }, SECRET);
  assert.throws(() => decodeOAuthState(future, SECRET, now), /took too long|invalid/);
});

test('the single-use registry consumes each id exactly once', () => {
  const registry = createSingleUse(3);
  assert.equal(registry.consume('a'), true);
  assert.equal(registry.consume('a'), false); // the replay fails server-side
  assert.equal(registry.consume('b'), true);
  assert.equal(registry.consume('c'), true);
  // beyond the cap the oldest id is evicted
  assert.equal(registry.consume('d'), true);
  assert.equal(registry.consume('b'), false);
  assert.equal(registry.consume('a'), true); // 'a' is the evicted one
});
