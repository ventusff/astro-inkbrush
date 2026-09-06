/**
 * What a share is, as a request describes it: the visibility with the
 * password or address that visibility calls for — one rule for creation
 * and for a change alike.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseIdentity } from '../src/wiki/shared/share-identity.ts';

test('no visibility means a password share, as older clients send it', () => {
  assert.deepEqual(parseIdentity({ password: 'hunter2-secret' }), { visibility: 'password', password: 'hunter2-secret', alias: null });
  assert.equal(parseIdentity({}), 'Password must be at least 6 characters');
  assert.equal(parseIdentity({ password: 'short' }), 'Password must be at least 6 characters');
});

test('a link or public share carries no password; only a public share has an address', () => {
  assert.deepEqual(parseIdentity({ visibility: 'link' }), { visibility: 'link', password: '', alias: null });
  assert.equal(parseIdentity({ visibility: 'link', password: 'hunter2-secret' }), 'A link share carries no password');
  assert.equal(parseIdentity({ visibility: 'link', alias: 'x' }), 'Only a public share can have an address');
  assert.deepEqual(parseIdentity({ visibility: 'public' }), { visibility: 'public', password: '', alias: null });
  assert.deepEqual(parseIdentity({ visibility: 'public', alias: ' my-note ' }), { visibility: 'public', password: '', alias: 'my-note' });
  assert.deepEqual(parseIdentity({ visibility: 'public', alias: '' }), { visibility: 'public', password: '', alias: null });
  assert.match(parseIdentity({ visibility: 'public', alias: 'Bad Alias' }) as string, /^Address:/);
});

test('unknown visibilities and wrongly typed fields are refused, not normalised away', () => {
  assert.equal(parseIdentity({ visibility: 'secret' }), 'visibility must be password, link or public');
  assert.equal(parseIdentity({ visibility: 7 }), 'visibility must be password, link or public');
  assert.equal(parseIdentity({ visibility: 'link', password: 123456 }), 'password must be a string');
  assert.equal(parseIdentity({ visibility: 'password', password: 'hunter2-secret', alias: ['foo'] }), 'alias must be a string');
  assert.equal(parseIdentity({ visibility: 'public', alias: 42 }), 'alias must be a string');
});
