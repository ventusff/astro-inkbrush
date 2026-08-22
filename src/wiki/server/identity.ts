/**
 * Optional identity registry — a file-based users.json (no database).
 * Off unless inkbrush.config.ts sets `identity: { dir }`. The file format is
 * plain JSON, `[{ "email", "name", "role" }]`, so several apps on one
 * machine can share one registry on disk.
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IdentityUser, IdentityUsersResponse } from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { IdentityValidationError, validateUserRecords } from './identity-records.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, json, readBody } from './index.ts';
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
  ensureSeeded(conf);
  const file = usersFile(conf);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`identity registry unreadable (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return validateUserRecords(parsed, conf.roles);
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
    throw new IdentityValidationError(
      `at least one '${conf.adminRole}' must remain`,
    );
  }
  return users;
}

/** full overwrite of the registry (vocabulary + at-least-one-admin enforced server-side) */
export function saveUsers(input: unknown): Promise<IdentityUser[]> {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  return withLock(usersFile(conf), () => {
    ensureSeeded(conf);
    const users = validateUsers(conf, input);
    writeUsers(conf, users);
    return users;
  });
}

/** first SSO login: an unknown user is registered with defaultRole; a known
 *  one is returned unchanged */
export function addUserIfAbsent(email: string, name: string): Promise<IdentityUser> {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  return withLock(usersFile(conf), () => {
    const users = readUsers(conf);
    const lower = email.toLowerCase();
    const found = users.find((u) => u.email.toLowerCase() === lower);
    if (found) return found;
    const user: IdentityUser = { email: lower, name, role: conf.defaultRole };
    users.push(user);
    writeUsers(conf, users);
    return user;
  });
}

/* ---------------- routes ---------------- */

export function registerIdentityRoutes(on: RouteRegistrar): void {
  on(
    'GET',
    '/identity/users',
    ({ res }) => {
      const conf = identityConfig()!; // admin gate ⇒ module on
      const body: IdentityUsersResponse = {
        users: listUsers(),
        roles: conf.roles,
        defaultRole: conf.defaultRole,
        adminRole: conf.adminRole,
      };
      json(res, 200, body);
    },
    { auth: 'admin' },
  );

  on(
    'PUT',
    '/identity/users',
    async ({ req, res }) => {
      const { users } = await readBody<{ users?: unknown }>(req);
      try {
        json(res, 200, { users: await saveUsers(users) });
      } catch (err) {
        if (err instanceof IdentityValidationError) return fail(res, 400, err.message);
        throw err;
      }
    },
    { auth: 'admin' },
  );
}
