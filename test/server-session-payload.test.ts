import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sessionPayloadUser } from '../src/wiki/server/session-payload.ts';

const NOW = 1_700_000_000_000;
const user = { name: 'Ada', email: 'ada@example.com', provider: 'google' };

test('a well-formed unexpired payload yields the user', () => {
  const result = sessionPayloadUser({ user, exp: NOW + 1000 }, NOW);
  assert.deepEqual(result, user);
  const withPicture = sessionPayloadUser(
    { user: { ...user, picture: 'https://example.com/a.png' }, exp: NOW + 1000 },
    NOW,
  );
  assert.equal(withPicture?.picture, 'https://example.com/a.png');
});

test('expiry must be a finite future number, exclusive at the boundary', () => {
  assert.equal(sessionPayloadUser({ user, exp: NOW - 1 }, NOW), null);
  // at exactly exp the session is dead
  assert.equal(sessionPayloadUser({ user, exp: NOW }, NOW), null);
  assert.equal(sessionPayloadUser({ user, exp: Number.NaN }, NOW), null);
  assert.equal(sessionPayloadUser({ user, exp: Number.POSITIVE_INFINITY }, NOW), null);
  assert.equal(sessionPayloadUser({ user, exp: '9999999999999' }, NOW), null);
  assert.equal(sessionPayloadUser({ user }, NOW), null);
});

test('user fields are validated, not cast', () => {
  const exp = NOW + 1000;
  assert.equal(sessionPayloadUser({ user: null, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, email: 'not-an-email' }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, email: 42 }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, name: '' }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, name: { evil: 1 } }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, provider: 'github' }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, picture: 123 }, exp }, NOW), null);
  assert.equal(sessionPayloadUser('a string', NOW), null);
  assert.equal(sessionPayloadUser(null, NOW), null);
});

test('over-length fields are refused', () => {
  const exp = NOW + 1000;
  assert.equal(sessionPayloadUser({ user: { ...user, email: `a@${'b'.repeat(320)}.com` }, exp }, NOW), null);
  assert.equal(sessionPayloadUser({ user: { ...user, name: 'n'.repeat(201) }, exp }, NOW), null);
  assert.equal(
    sessionPayloadUser({ user: { ...user, picture: `https://x/${'p'.repeat(2048)}` }, exp }, NOW),
    null,
  );
});
