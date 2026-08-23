/**
 * Cookie-CSRF origin gate for the /api/wiki router: a mutating request that
 * could ride on the session cookie must originate from this site or a
 * configured trusted origin. Kept free of config/server imports so the rule
 * is unit-testable.
 */

/**
 * True when the request must be refused as cross-site.
 *
 *  - Safe methods (GET/HEAD/OPTIONS) pass: they never mutate.
 *  - The SAML ACS route (`/auth/saml/callback`) passes: the IdP posts it
 *    cross-origin by design, its authentication is the signed assertion plus
 *    InResponseTo validation, and it exercises no session-cookie authority.
 *  - A request with no Origin and no Referer passes: it is not a browser
 *    form post.
 */
export function crossSiteBlocked(opts: {
  method: string;
  /** router path inside /api/wiki, e.g. '/auth/saml/callback' */
  path: string;
  /** the request's Origin header (or the Referer's origin); null when absent */
  origin: string | null;
  /** the request's own origins as a browser would send them: the origin
   *  derived from the request (its public host), and the configured base
   *  URL when auth pins one — a deployment that borrows another origin's
   *  SP identity is still its own origin for its own pages */
  ownOrigins: string[];
  trustedOrigins: string[];
}): boolean {
  if (opts.method === 'GET' || opts.method === 'HEAD' || opts.method === 'OPTIONS') return false;
  if (opts.path === '/auth/saml/callback') return false;
  if (!opts.origin) return false;
  return !new Set([...opts.ownOrigins, ...opts.trustedOrigins]).has(opts.origin);
}
