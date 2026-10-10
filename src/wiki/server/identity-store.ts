/**
 * Optional identity registry — a file-based users.json (no database).
 * Off unless inkbrush.config.ts sets `identity: { dir }`. The file format is
 * plain JSON, `[{ "email", "name", "role", "aliases"? }]`, so several apps
 * on one machine can share one registry on disk. This module reads and
 * writes it; ./identity.ts serves it over the API.
 *
 * With the registry on, membership is authorization: every signed-in
 * request must belong to a current member (the router enforces this), and
 * admin routes to a member holding the admin role. Roles never enter the
 * session token — every check re-reads users.json, so a change or a removal
 * takes effect on the next request.
 *
 * Invariants (server-enforced):
 *  - roles are validated against the configured vocabulary (identity.roles);
 *  - at least one user with the adminRole must always exist — a registry
 *    cannot be created without one (ADMIN_EMAILS seeds the first admins
 *    when users.json is missing; an empty seed is a startup error);
 *  - writes are atomic, and a read-modify-write holds the file's lock.
 *
 * SSO first login registers the user with defaultRole when
 * `identity.autoRegister` is on (default); otherwise unknown users are
 * refused at login.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { failure } from '../shared/errors.ts';
import type { IdentityUser, WikiUser } from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { cleanName, IdentityValidationError, NAME_MAX, validateUserRecords } from './identity-records.ts';
import { withLock, writeFileAtomic } from './store.ts';

export { IdentityValidationError };

type IdentityConf = NonNullable<ReturnType<typeof wikiConfig>['identity']>;

/** resolved identity config, or null = module off */
export function identityConfig(): IdentityConf | null {
  return wikiConfig().identity;
}

function usersFile(conf: IdentityConf): string {
  return join(conf.dir, 'users.json');
}

function writeUsers(conf: IdentityConf, users: IdentityUser[]): void {
  // the registry holds emails and roles: the directory is private (0700)
  mkdirSync(conf.dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(usersFile(conf), JSON.stringify(users, null, 2));
}

/** first run: seed users.json from ADMIN_EMAILS; a missing file with no
 *  seed is an error, never an empty registry */
function ensureSeeded(conf: IdentityConf): void {
  if (existsSync(usersFile(conf))) return;
  const admins = (process.env['ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
  if (admins.length === 0) {
    throw new Error(
      `identity registry: ${usersFile(conf)} does not exist and ADMIN_EMAILS names no administrator — set ADMIN_EMAILS to seed the first admin`,
    );
  }
  writeUsers(
    conf,
    admins.map((email) => ({ email, name: email.split('@')[0] ?? email, role: conf.adminRole })),
  );
}

/** startup check: the registry (when on) exists or can be seeded, and parses */
export function ensureRegistry(): void {
  const conf = identityConfig();
  if (conf) readUsers(conf);
}

/** the registry; a file that exists but does not parse — or whose records
 *  violate the write-side invariants (shape, email, role vocabulary, no
 *  duplicates) — is an error, never an empty or partial list (fail closed:
 *  the next write would otherwise erase recoverable members) */
function readUsers(conf: IdentityConf): IdentityUser[] {
  return readRegistry(conf).users;
}

/** the registry and its revision (a digest of the file as stored) */
function readRegistry(conf: IdentityConf): { users: IdentityUser[]; revision: string } {
  ensureSeeded(conf);
  const file = usersFile(conf);
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(file, 'utf8');
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`identity registry unreadable (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return { users: validateUserRecords(parsed, conf.roles, { lenient: true }), revision: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  } catch (err) {
    throw new Error(
      `identity registry invalid (${file}): ${err instanceof Error ? err.message : String(err)} — refusing to use it`,
    );
  }
}

export function listUsers(): IdentityUser[] {
  const conf = identityConfig();
  return conf ? readUsers(conf) : [];
}

export function findUser(email: string): IdentityUser | null {
  const conf = identityConfig();
  if (!conf) return null;
  const lower = email.toLowerCase();
  return readUsers(conf).find((u) => u.email.toLowerCase() === lower) ?? null;
}

/** normalize + validate an untrusted users list against the configured
 *  vocabulary (shared with the read side) and the at-least-one-admin
 *  invariant; throws IdentityValidationError */
function validateUsers(conf: IdentityConf, input: unknown): IdentityUser[] {
  const users = validateUserRecords(input, conf.roles);
  if (!users.some((u) => u.role === conf.adminRole)) {
    throw new IdentityValidationError(failure('members-admin', { role: conf.adminRole }));
  }
  return users;
}

/** the members list with its revision, for the admins' dialog */
export function listUsersWithRevision(): { users: IdentityUser[]; revision: string } {
  const conf = identityConfig();
  return conf ? readRegistry(conf) : { users: [], revision: '' };
}

/** full overwrite of the registry (vocabulary + at-least-one-admin enforced
 *  server-side); with `revision`, only over that version — a list another
 *  admin changed meanwhile is refused with IdentityConflictError */
export function saveUsers(input: unknown, revision?: string): Promise<{ users: IdentityUser[]; revision: string }> {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  return withLock(usersFile(conf), () => {
    if (revision !== undefined && readRegistry(conf).revision !== revision) throw new IdentityConflictError();
    const users = validateUsers(conf, input);
    writeUsers(conf, users);
    return readRegistry(conf);
  });
}

/** the registry changed since the version a save was made against */
export class IdentityConflictError extends Error {
  constructor() {
    super('the members list changed meanwhile');
    this.name = 'IdentityConflictError';
  }
}

/** a member renames themself; the name is validated like an admin's edit */
export function renameUser(email: string, name: unknown): Promise<IdentityUser> {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  return withLock(usersFile(conf), () => {
    const users = readUsers(conf);
    const lower = email.toLowerCase();
    const index = users.findIndex((u) => u.email.toLowerCase() === lower);
    if (index === -1) throw new IdentityValidationError(failure('not-member'));
    const clean = cleanName(name);
    if (clean === null) throw new IdentityValidationError(failure('members-name', { email: lower, max: NAME_MAX }));
    const next = users.map((u, i) => (i === index ? { ...u, name: clean } : u));
    writeUsers(conf, validateUsers(conf, next));
    return next[index]!;
  });
}

/** first SSO login: an unknown user is registered with defaultRole, under
 *  the provider's name when it is a valid one (else the email prefix); a
 *  known one is returned unchanged. A registration the registry's rules
 *  refuse — the address already is another member's commit address — throws
 *  IdentityValidationError and writes nothing, so a sign-in can never leave
 *  a record behind that the next read would reject */
export function addUserIfAbsent(email: string, name: string): Promise<IdentityUser> {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  return withLock(usersFile(conf), () => {
    const users = readUsers(conf);
    const lower = email.toLowerCase();
    const found = users.find((u) => u.email.toLowerCase() === lower);
    if (found) return found;
    const next = validateUsers(conf, [...users, { email: lower, name: cleanName(name) ?? '', role: conf.defaultRole }]);
    writeUsers(conf, next);
    return next[next.length - 1]!;
  });
}

/** a signed-in user as the site shows them: under the registry's name for
 *  them, so renaming a member shows at once everywhere — bylines, comments,
 *  history, commits — without waiting for their next sign-in */
export function named(user: WikiUser | null): WikiUser | null {
  if (!user || !identityConfig()) return user;
  const name = findUser(user.email)?.name;
  return name && name !== user.name ? { ...user, name } : user;
}
