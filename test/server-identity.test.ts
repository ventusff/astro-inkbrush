import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IdentityValidationError, validateUserRecords } from '../src/wiki/server/identity-records.ts';

const roles = ['member', 'admin'];

test('valid records normalize: lowercased emails, name falling back to the prefix', () => {
  const users = validateUserRecords(
    [
      { email: 'Ada@Example.com', name: '  Ada  ', role: 'admin' },
      { email: 'bob@example.com', name: '', role: 'member' },
    ],
    roles,
  );
  assert.deepEqual(users, [
    { email: 'ada@example.com', name: 'Ada', role: 'admin' },
    { email: 'bob@example.com', name: 'bob', role: 'member' },
  ]);
});

test('shape violations are refused', () => {
  assert.throws(() => validateUserRecords({ email: 'a@b' }, roles), IdentityValidationError);
  assert.throws(() => validateUserRecords(['a@b'], roles), /must be an object/);
  assert.throws(() => validateUserRecords([null], roles), /must be an object/);
});

test('emails must contain @ and be unique (case-insensitively)', () => {
  assert.throws(() => validateUserRecords([{ email: 'nope', name: 'x', role: 'admin' }], roles), /invalid email/);
  assert.throws(() => validateUserRecords([{ name: 'x', role: 'admin' }], roles), /invalid email/);
  assert.throws(
    () =>
      validateUserRecords(
        [
          { email: 'a@b.c', name: 'x', role: 'admin' },
          { email: 'A@B.C', name: 'y', role: 'member' },
        ],
        roles,
      ),
    /duplicate email/,
  );
});

test('roles must come from the configured vocabulary', () => {
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'x', role: 'owner' }], roles), /unknown role/);
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'x' }], roles), /unknown role/);
});
