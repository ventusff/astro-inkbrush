/**
 * The identity registry's API (./identity-store.ts holds the registry):
 * the admins' members list and its full overwrite, every member's handle
 * and name for `@` completion, and a member renaming themself.
 */
import { peopleOf } from '../../lib/people.ts';
import { failure } from '../shared/errors.ts';
import type { IdentityUsersResponse, PeopleResponse } from '../shared/types.ts';
import { IdentityConflictError, identityConfig, IdentityValidationError, listUsers, listUsersWithRevision, renameUser, saveUsers } from './identity-store.ts';
import type { RouteRegistrar } from './index.ts';
import { failureBody, json, readBody } from './index.ts';

/* ---------------- routes ---------------- */

export function registerIdentityRoutes(on: RouteRegistrar): void {
  on(
    'GET',
    '/identity/users',
    ({ res }) => {
      const conf = identityConfig()!; // admin gate ⇒ module on
      const body: IdentityUsersResponse = {
        ...listUsersWithRevision(),
        roles: conf.roles,
        defaultRole: conf.defaultRole,
        adminRole: conf.adminRole,
      };
      json(res, 200, body);
    },
    { auth: 'admin' },
  );

  // every member sees every member's handle and name: what `@` completes and bylines show
  on(
    'GET',
    '/identity/people',
    ({ res }) => {
      const body: PeopleResponse = { people: peopleOf(listUsers()).map(({ handle, name }) => ({ handle, name })) };
      json(res, 200, body);
    },
    { auth: true },
  );

  on(
    'PUT',
    '/identity/me',
    async ({ req, res, user }) => {
      if (!identityConfig()) return json(res, 404, failureBody(failure('bad-request', { detail: 'identity module is off' })));
      const { name } = await readBody<{ name?: unknown }>(req);
      try {
        const record = await renameUser(user!.email, name);
        json(res, 200, { name: record.name });
      } catch (err) {
        if (err instanceof IdentityValidationError) return json(res, 400, failureBody(err.failure));
        throw err;
      }
    },
    { auth: true },
  );

  on(
    'PUT',
    '/identity/users',
    async ({ req, res }) => {
      const { users, revision } = await readBody<{ users?: unknown; revision?: unknown }>(req);
      try {
        json(res, 200, await saveUsers(users, typeof revision === 'string' ? revision : undefined));
      } catch (err) {
        if (err instanceof IdentityConflictError) return json(res, 409, failureBody(failure('members-stale')));
        if (err instanceof IdentityValidationError) return json(res, 400, failureBody(err.failure));
        throw err;
      }
    },
    { auth: 'admin' },
  );
}
