/**
 * Optional identity registry — a file-based users.json (no database, ever).
 * Off unless inkbrush.config.ts sets `identity: { dir }`. The file format is
 * plain JSON: `[{ "email", "name", "role" }]`, so several apps on one
 * machine can share a single registry on disk.
 *
 * Invariants (server-enforced):
 *  - roles are validated against the configured vocabulary (identity.roles);
 *  - at least one user with the adminRole must always remain;
 *  - writes are atomic (tmp + rename). All fs ops are synchronous, so a
 *    read-modify-write never interleaves within one process.
 *
 * Seeding: when users.json is missing, the ADMIN_EMAILS env var (comma
 * separated) seeds the first admin(s). SSO first-login auto-provisions new
 * users with defaultRole (addUserIfAbsent — called from the SAML callback).
 *
 * Roles never enter the session token: every check re-reads users.json, so
 * role changes / removals take effect immediately.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IdentityUser, IdentityUsersResponse } from '../shared/types';
import { wikiConfig } from './config';
import type { RouteRegistrar } from './index';
import { fail, json, readBody } from './index';

type IdentityConf = NonNullable<ReturnType<typeof wikiConfig>['identity']>;

/** resolved identity config, or null = module off */
export function identityConfig(): IdentityConf | null {
  return wikiConfig().identity;
}

/** validation failures the API maps to 400 (vs unexpected errors → 500) */
export class IdentityValidationError extends Error {}

function usersFile(conf: IdentityConf): string {
  return join(conf.dir, 'users.json');
}

function writeUsersAtomic(conf: IdentityConf, users: IdentityUser[]): void {
  mkdirSync(conf.dir, { recursive: true });
  const file = usersFile(conf);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(users, null, 2));
  renameSync(tmp, file);
}

/** first run: seed users.json from ADMIN_EMAILS (only when the file is
 *  missing; an empty list still writes the file) */
function ensureSeeded(conf: IdentityConf): void {
  if (existsSync(usersFile(conf))) return;
  const admins = (process.env['ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  writeUsersAtomic(
    conf,
    admins.map((email) => ({ email, name: email.split('@')[0] ?? email, role: conf.adminRole })),
  );
}

/**
 * Read the registry. A damaged users.json must NEVER degrade into "empty
 * registry": the next SSO login would then auto-provision one user and
 * writeUsersAtomic would rewrite the file down to that single entry — the whole
 * team's roles silently gone. So parse failures throw; only a genuinely missing
 * file is empty, and that case is handled by ensureSeeded above (which creates
 * it). Repair path: fix users.json on disk (or restore it from git/backup).
 */
function readUsers(conf: IdentityConf): IdentityUser[] {
  ensureSeeded(conf);
  const file = usersFile(conf);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[wiki identity] users.json unreadable/unparsable — refusing to continue with an empty registry: ${file} — ${reason}`);
    throw new Error(`identity registry unreadable (${file}): ${reason}`);
  }
  if (!Array.isArray(parsed)) {
    console.error(`[wiki identity] users.json is not an array — refusing to continue with an empty registry: ${file}`);
    throw new Error(`identity registry is not an array (${file})`);
  }
  return parsed as IdentityUser[];
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
 *  vocabulary and the at-least-one-admin invariant; throws IdentityValidationError */
function validateUsers(conf: IdentityConf, input: unknown): IdentityUser[] {
  if (!Array.isArray(input)) {
    throw new IdentityValidationError('users must be an array');
  }
  const seen = new Set<string>();
  const users = input.map((entry): IdentityUser => {
    const rec = entry as Partial<IdentityUser> | null;
    const email = typeof rec?.email === 'string' ? rec.email.trim().toLowerCase() : '';
    if (!email.includes('@')) {
      throw new IdentityValidationError(`invalid email: '${String(rec?.email ?? '')}'`);
    }
    if (seen.has(email)) {
      throw new IdentityValidationError(`duplicate email: ${email}`);
    }
    seen.add(email);
    const role = typeof rec?.role === 'string' ? rec.role : '';
    if (!conf.roles.includes(role)) {
      throw new IdentityValidationError(
        `unknown role '${role}' (allowed: ${conf.roles.join(', ')})`,
      );
    }
    const name = typeof rec?.name === 'string' && rec.name.trim() ? rec.name.trim() : (email.split('@')[0] ?? email);
    return { email, name, role };
  });
  if (!users.some((u) => u.role === conf.adminRole)) {
    throw new IdentityValidationError(
      `at least one '${conf.adminRole}' must remain`,
    );
  }
  return users;
}

/** full overwrite of the registry (vocabulary + at-least-one-admin enforced server-side) */
export function saveUsers(input: unknown): IdentityUser[] {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  ensureSeeded(conf);
  const users = validateUsers(conf, input);
  writeUsersAtomic(conf, users);
  return users;
}

/** first SSO login: new users auto-register with defaultRole; existing users
 *  are returned unchanged */
export function addUserIfAbsent(email: string, name: string): IdentityUser {
  const conf = identityConfig();
  if (!conf) throw new Error('identity module is off');
  const users = readUsers(conf);
  const lower = email.toLowerCase();
  const found = users.find((u) => u.email.toLowerCase() === lower);
  if (found) return found;
  const user: IdentityUser = { email: lower, name, role: conf.defaultRole };
  users.push(user);
  writeUsersAtomic(conf, users);
  return user;
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
        json(res, 200, { users: saveUsers(users) });
      } catch (err) {
        if (err instanceof IdentityValidationError) return fail(res, 400, err.message);
        throw err;
      }
    },
    { auth: 'admin' },
  );
}
