/**
 * `astro-inkbrush/session` — the one public, READ-ONLY identity contract.
 *
 * Sibling applications (other middleware mounted in the same process, other
 * data planes on the same domain) regularly need to answer one question:
 * "who is behind this request?". They should not re-implement the cookie
 * signing format to do it, and they definitely should not import the whole
 * auth module (which can also issue cookies and run OAuth exchanges).
 *
 * So this module exports only the reading half:
 *   - currentUser(req) → signed-in user | null
 *   - the WikiUser type
 *
 * Issuing, logout and provider flows never leave the package — write access
 * to identity belongs to the CMS alone. Consumers make their own
 * authorization decisions on the returned WikiUser (roles/allowlists are the
 * consumer's business; this package doesn't decide for anyone).
 */
import type { IncomingMessage } from 'node:http';

import type { WikiUser } from '../shared/types.ts';
import { sessionUser } from './auth.ts';
import { named } from './identity-store.ts';

export type { WikiUser };

/** validate the session cookie and return the identity — under the
 *  identity registry's name for the user when the registry is on; no
 *  cookie / bad signature / expired all yield null */
export async function currentUser(req: IncomingMessage): Promise<WikiUser | null> {
  return named(await sessionUser(req));
}
