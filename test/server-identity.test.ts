import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IdentityValidationError, validateUserRecords } from '../src/wiki/server/identity-records.ts';
import type { WikiErrorCode } from '../src/wiki/shared/errors.ts';

/** a validation refusal carrying `code` */
function refusedWith(code: WikiErrorCode): (err: unknown) => boolean {
  return (err) => err instanceof IdentityValidationError && err.failure.code === code;
}

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
    { email: 'ada@example.com', name: 'Ada', role: 'admin', handle: 'ada' },
    { email: 'bob@example.com', name: 'bob', role: 'member', handle: 'bob' },
  ]);
});

test('shape violations are refused', () => {
  assert.throws(() => validateUserRecords({ email: 'a@b' }, roles), IdentityValidationError);
  assert.throws(() => validateUserRecords(['a@b'], roles), /must be an object/);
  assert.throws(() => validateUserRecords([null], roles), /must be an object/);
});

test('emails must contain @ and be unique (case-insensitively)', () => {
  assert.throws(() => validateUserRecords([{ email: 'nope', name: 'x', role: 'admin' }], roles), refusedWith('members-email'));
  assert.throws(() => validateUserRecords([{ name: 'x', role: 'admin' }], roles), refusedWith('members-email'));
  assert.throws(
    () =>
      validateUserRecords(
        [
          { email: 'a@b.c', name: 'x', role: 'admin' },
          { email: 'A@B.C', name: 'y', role: 'member' },
        ],
        roles,
      ),
    refusedWith('members-duplicate'),
  );
});

test('roles must come from the configured vocabulary', () => {
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'x', role: 'owner' }], roles), refusedWith('members-role'));
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'x' }], roles), refusedWith('members-role'));
});

test('names are one clean line; other addresses are emails, deduplicated, and belong to one member only', () => {
  const users = validateUserRecords(
    [{ email: 'a@b.c', name: 'Ada', role: 'admin', aliases: [' Ada@Home.org ', 'ada@home.org', 'a@b.c'] }],
    roles,
  );
  assert.deepEqual(users, [{ email: 'a@b.c', name: 'Ada', role: 'admin', handle: 'a', aliases: ['ada@home.org'] }]);
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'A <x>', role: 'admin' }], roles), refusedWith('members-name'));
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'x'.repeat(61), role: 'admin' }], roles), refusedWith('members-name'));
  for (const bad of ['a\u0000b', 'a\tb', 'a\u202eb', 'a\u2066b'])
    assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: bad, role: 'admin' }], roles), refusedWith('members-name'), JSON.stringify(bad));
  assert.equal(validateUserRecords([{ email: 'a@b.c', name: '郭 健飞 · Jeff', role: 'admin' }], roles)[0]!.name, '郭 健飞 · Jeff');
  assert.throws(() => validateUserRecords([{ email: 'a@b.c', name: 'Ada', role: 'admin', aliases: ['home'] }], roles), refusedWith('members-alias'));
  assert.throws(
    () =>
      validateUserRecords(
        [
          { email: 'a@b.c', name: 'Ada', role: 'admin', aliases: ['bob@b.c'] },
          { email: 'bob@b.c', name: 'Bob', role: 'member' },
        ],
        roles,
      ),
    refusedWith('members-alias-taken'),
  );
  assert.throws(
    () =>
      validateUserRecords(
        [
          { email: 'a@b.c', name: 'Ada', role: 'admin', aliases: ['x@y.z'] },
          { email: 'bob@b.c', name: 'Bob', role: 'member', aliases: ['x@y.z'] },
        ],
        roles,
      ),
    refusedWith('members-alias-taken'),
  );
});

test('a first sign-in registers under a clean name, and never writes a record the registry would reject', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setConfigInput } = await import('../src/wiki/server/config.ts');
  const store = await import('../src/wiki/server/identity-store.ts');
  const dir = mkdtempSync(join(tmpdir(), 'inkbrush-identity-'));
  const file = join(dir, 'users.json');
  writeFileSync(file, JSON.stringify([{ email: 'admin@b.c', name: 'Admin', role: 'admin', aliases: ['home@x.org'] }]));
  setConfigInput({ identity: { dir } });
  try {
    const before = readFileSync(file, 'utf8');
    await assert.rejects(store.addUserIfAbsent('home@x.org', 'Someone'), store.IdentityValidationError);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal((await store.addUserIfAbsent('new@b.c', 'Evil <x>')).name, 'new');
    assert.equal((await store.addUserIfAbsent('long@b.c', 'y'.repeat(80))).name, 'long');
    assert.equal(store.listUsers().length, 3);
    assert.deepEqual(store.named({ name: 'stale', email: 'admin@b.c', provider: 'dev' }), { name: 'Admin', email: 'admin@b.c', provider: 'dev' });

    const seen = store.listUsersWithRevision();
    const saved = await store.saveUsers(seen.users.map((u) => (u.email === 'new@b.c' ? { ...u, name: 'New Name' } : u)), seen.revision);
    assert.notEqual(saved.revision, seen.revision);
    await assert.rejects(store.saveUsers(seen.users, seen.revision), store.IdentityConflictError);
    assert.equal(store.findUser('new@b.c')?.name, 'New Name');
  } finally {
    setConfigInput(null);
  }
});

test('a read mends what only names a person and refuses what grants access', () => {
  const read = (u: unknown) => validateUserRecords(u, roles, { lenient: true });
  const users = read([
    { email: 'a@b.c', name: 'A <bad>', role: 'admin', aliases: ['home', 'b@b.c', 'ok@x.org'] },
    { email: 'b@b.c', name: 'x'.repeat(80), role: 'member', aliases: ['ok@x.org'] },
  ]);
  assert.deepEqual(users, [
    { email: 'a@b.c', name: 'a', role: 'admin', handle: 'a', aliases: ['ok@x.org'] },
    { email: 'b@b.c', name: 'b', role: 'member', handle: 'b' },
  ]);
  assert.throws(() => read([{ email: 'a@b.c', name: 'A', role: 'owner' }]), refusedWith('members-role'));
  assert.throws(() => read([{ email: 'nope', name: 'A', role: 'admin' }]), refusedWith('members-email'));
});

test('handles are kept once given: a member leaving or joining changes nobody else\'s', () => {
  const first = validateUserRecords(
    [
      { email: 'sam@a.com', name: 'Sam A', role: 'admin' },
      { email: 'sam@b.com', name: 'Sam B', role: 'member' },
      { email: 'Jane+Wiki@a.com', name: 'Jane', role: 'member' },
    ],
    roles,
  );
  assert.deepEqual(first.map((u) => u.handle), ['sam', 'sam.b', 'jane-wiki']);
  const after = validateUserRecords([first[1], first[2], { email: 'sam@c.com', name: 'Sam C', role: 'admin' }], roles);
  assert.deepEqual(after.map((u) => u.handle), ['sam.b', 'jane-wiki', 'sam']);
});
