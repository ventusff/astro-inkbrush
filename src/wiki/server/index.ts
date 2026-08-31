/**
 * /api/wiki/* — connect-style middleware entry, loaded through
 * `server.ssrLoadModule` by the wiki integration (so it gets HMR in dev).
 *
 * A small router over Node's raw req/res; streaming endpoints (claude)
 * write NDJSON chunks to the response directly.
 *
 * Request contract:
 *  - a route's `auth` gate: false = public; true = a signed-in user who,
 *    when the identity registry is on, is a current member; 'admin' = a
 *    member holding the admin role (404 while the registry is off);
 *  - a mutating request (anything but GET/HEAD) that carries a session
 *    cookie must come from this site: its Origin (or Referer) must be the
 *    request's own origin — the configured auth baseUrl when one is set,
 *    otherwise derived from the request, honoring forwarding headers only
 *    under `server.trustProxy` — or a configured trusted origin (the SAML
 *    ACS route is exempt — see ./csrf.ts), and a JSON body must be declared
 *    as application/json;
 *  - malformed input (bad percent-encoding, a body that is not JSON, a body
 *    over the limit) is a 4xx; an unexpected failure is logged with a
 *    request id and answered with a generic 500 carrying that id.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MeResponse, WikiUser } from '../shared/types.ts';
import {
  clearOAuthCookie,
  clearSessionCookie,
  configuredBaseUrl,
  createSessionCookie,
  devLoginEnabled,
  googleAuthStart,
  googleAuthVerify,
  googleExchangeCode,
  googleState,
  isSecureRequest,
  safeReturnUrl,
  sessionUser,
} from './auth.ts';
import { wikiConfig } from './config.ts';
import { crossSiteBlocked } from './csrf.ts';
import {
  addUserIfAbsent as addIdentityUserIfAbsent,
  ensureRegistry,
  findUser as findIdentityUser,
  identityConfig,
} from './identity.ts';
import { buildSaml, displayNameFromProfile, googleSamlState, samlEmailAllowed } from './saml.ts';
import { shareState } from './share.ts';
import { setSiteHooks, type SiteMarkdownHooks } from './site.ts';
import { setProjectRoot } from './store.ts';

export interface ApiOptions {
  root: string;
  /** the site's Markdown pipeline, from `inkbrush({ markdown })` */
  markdown?: SiteMarkdownHooks | undefined;
}

/* ---------------- plumbing ---------------- */

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  user: WikiUser | null;
}

type Handler = (ctx: Ctx) => void | Promise<void>;

interface Route {
  method: string;
  parts: string[]; // pattern segments; ":x" = param, "*rest" = greedy tail param
  handler: Handler;
  /** false = public · true = any signed-in user · 'admin' = identity module
   *  on AND the user's registry role === adminRole (module off ⇒ 404) */
  auth: boolean | 'admin';
}

const routes: Route[] = [];

function on(
  method: string,
  pattern: string,
  handler: Handler,
  opts?: { auth?: boolean | 'admin' },
): void {
  routes.push({
    method,
    parts: pattern.split('/').filter(Boolean),
    handler,
    auth: opts?.auth ?? false,
  });
}

/** percent-decoding that answers 400 instead of throwing on a bad sequence */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, `malformed path segment: ${seg}`);
  }
}

function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const segs = path.split('/').filter(Boolean);
  outer: for (const route of routes) {
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.parts.length; i++) {
      const part = route.parts[i]!;
      if (part.startsWith('*')) {
        if (i >= segs.length) continue outer;
        params[part.slice(1)] = segs.slice(i).map(decodeSegment).join('/');
        return { route, params };
      }
      const seg = segs[i];
      if (seg === undefined) continue outer;
      if (part.startsWith(':')) params[part.slice(1)] = decodeSegment(seg);
      else if (part !== seg) continue outer;
    }
    if (segs.length !== route.parts.length) continue;
    return { route, params };
  }
  return null;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function fail(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

/** an error carrying the HTTP status the router should answer with (4xx
 *  semantics — logged as a warning, no console.error stack) */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** request body ceiling; every endpoint posts small JSON (a note's markdown at most) */
export const BODY_LIMIT = 1024 * 1024;

/** buffer the request body with a hard ceiling; over the limit ⇒ 413, and
 *  the rest of the body is drained so the response can still be sent and
 *  the connection closed cleanly */
async function readCapped(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  const declared = Number(req.headers['content-length']);
  const tooBig = (): HttpError => new HttpError(413, `Request body too large (max ${limit} bytes)`);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw tooBig();
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(tooBig());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** a JSON body: declared as application/json (415 otherwise, an empty or
 *  absent body included — the declaration is part of the contract), parsed,
 *  or a 400 */
export async function readBody<T>(req: IncomingMessage): Promise<T> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    throw new HttpError(415, 'JSON bodies must be sent as application/json');
  }
  const text = await readCapped(req);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/** application/x-www-form-urlencoded reader (SAML ACS posts) */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readCapped(req));
}

function redirect(res: ServerResponse, status: 302 | 303, location: string): void {
  res.statusCode = status;
  res.setHeader('location', location);
  res.end();
}

/** open an NDJSON stream (claude jobs); returns a line writer + closer */
export function ndjsonStream(res: ServerResponse): {
  write: (obj: unknown) => void;
  close: () => void;
} {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  return {
    write: (obj) => res.write(`${JSON.stringify(obj)}\n`),
    close: () => res.end(),
  };
}

/* ---------------- auth routes ---------------- */

on('GET', '/me', ({ req, user, res }) => {
  const identity = identityConfig();
  const record = identity && user ? findIdentityUser(user.email) : null;
  const body: MeResponse = {
    user,
    providers: { dev: devLoginEnabled(req), google: googleState(), googleSaml: googleSamlState() },
    share: shareState(),
    ...(identity && user
      ? {
          role: record?.role ?? null,
          siteRole: record?.role === identity.adminRole ? ('admin' as const) : ('member' as const),
        }
      : {}),
  };
  json(res, 200, body);
});

on('POST', '/auth/dev', async ({ req, res }) => {
  if (!devLoginEnabled(req)) {
    return fail(
      res,
      403,
      'Dev login is disabled (inkbrush.config.ts → auth.dev; without an explicit dev: true it serves loopback clients only)',
    );
  }
  const { name, email } = await readBody<{ name?: string; email?: string }>(req);
  if (!name?.trim() || !email?.includes('@')) return fail(res, 400, 'A name and a valid email are required');
  const user: WikiUser = { name: name.trim(), email: email.trim(), provider: 'dev' };
  res.setHeader('set-cookie', await createSessionCookie(user, req));
  json(res, 200, { user });
});

on('GET', '/auth/google', ({ req, res, query }) => {
  const state = googleState();
  if (state === 'off') {
    return fail(res, 404, 'Google login is not enabled (inkbrush.config.ts → auth.google)');
  }
  if (state === 'unconfigured') {
    return fail(res, 503, 'Google login is enabled but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is missing from the environment');
  }
  const start = googleAuthStart(req, safeReturnUrl(query.get('return')));
  res.setHeader('set-cookie', start.cookie);
  redirect(res, 302, start.url);
});

on('GET', '/auth/google/callback', async ({ req, res, query }) => {
  const code = query.get('code');
  if (!code) return fail(res, 400, 'missing code');
  try {
    const { returnTo, verifier } = googleAuthVerify(req, query.get('state'));
    const user = await googleExchangeCode(req, code, verifier);
    await provision(user);
    res.setHeader('set-cookie', [await createSessionCookie(user, req), clearOAuthCookie(req)]);
    redirect(res, 302, returnTo);
  } catch (err) {
    res.setHeader('set-cookie', clearOAuthCookie(req));
    fail(res, 403, err instanceof Error ? err.message : 'Google sign-in failed');
  }
});

/** first SSO login registers the user (identity.autoRegister); the
 *  registry's name for a known user wins over the provider's */
async function provision(user: WikiUser): Promise<void> {
  const identity = identityConfig();
  if (!identity) return;
  if (identity.autoRegister) {
    const record = await addIdentityUserIfAbsent(user.email, user.name);
    if (record.name.trim()) user.name = record.name;
  } else {
    const record = findIdentityUser(user.email);
    if (!record) throw new Error(`${user.email} is not a member of this site`);
    if (record.name.trim()) user.name = record.name;
  }
}

/* —— Google Workspace SAML SSO (SP-initiated; see ./saml.ts) —— */

on('GET', '/auth/saml/login', async ({ res, query }) => {
  const state = googleSamlState();
  if (state === 'off') {
    return fail(res, 404, 'SAML login is not enabled (inkbrush.config.ts → auth.googleSaml)');
  }
  if (state === 'unconfigured') {
    return fail(
      res,
      503,
      'SAML login is enabled but not fully configured (entryPoint / idpEntityId / certFile / baseUrl)',
    );
  }
  const relay = safeReturnUrl(query.get('return'));
  try {
    const { saml } = buildSaml();
    redirect(res, 302, await saml.getAuthorizeUrlAsync(relay, undefined, {}));
  } catch (err) {
    console.warn('[wiki saml] failed to build the login request', err instanceof Error ? err.message : err);
    redirect(res, 302, '/?login_error=saml_config');
  }
});

// ACS contract: application/x-www-form-urlencoded SAMLResponse+RelayState
// (as registered with the IdP). Every failure degrades gracefully to a
// 303 back to /?login_error=<code> — this endpoint must never 500.
on('POST', '/auth/saml/callback', async ({ req, res }) => {
  const errorRedirect = (code: string): void => redirect(res, 303, `/?login_error=${code}`);
  try {
    if (googleSamlState() !== 'ready') return errorRedirect('saml_disabled');
    const { saml } = buildSaml();

    let samlResponse = '';
    let relayState = '';
    try {
      const form = await readForm(req);
      samlResponse = form.get('SAMLResponse') ?? '';
      relayState = form.get('RelayState') ?? '';
    } catch {
      return errorRedirect('saml_response');
    }
    if (!samlResponse) return errorRedirect('saml_response');

    let email = '';
    let name = '';
    try {
      const { profile, loggedOut } = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
        RelayState: relayState,
      });
      if (loggedOut || !profile?.nameID) return errorRedirect('saml_invalid');
      email = profile.nameID.trim().toLowerCase();
      name = displayNameFromProfile(profile, email);
    } catch (err) {
      console.warn('[wiki saml] assertion validation failed', err instanceof Error ? err.message : err);
      return errorRedirect('saml_invalid');
    }
    if (!email.includes('@')) return errorRedirect('saml_invalid');

    // email-domain allowlist, enforced server-side
    if (!samlEmailAllowed(email)) return errorRedirect('wrong_domain');

    const user: WikiUser = { name, email, provider: 'google-saml' };
    try {
      await provision(user);
    } catch {
      return errorRedirect('not_member');
    }
    res.setHeader('set-cookie', await createSessionCookie(user, req));
    redirect(res, 303, safeReturnUrl(relayState));
  } catch (err) {
    console.error('[wiki saml] callback failed', err);
    if (!res.headersSent) errorRedirect('saml_error');
    else res.end();
  }
});

// contract: SP metadata must be servable even before the IdP cert is
// configured (so entityID/ACS can be verified during setup)
on('GET', '/auth/saml/metadata', ({ res }) => {
  if (googleSamlState() === 'off') {
    return fail(res, 404, 'SAML login is not enabled (inkbrush.config.ts → auth.googleSaml)');
  }
  const { saml } = buildSaml();
  res.statusCode = 200;
  res.setHeader('content-type', 'application/xml');
  res.end(saml.generateServiceProviderMetadata(null, null));
});

on('POST', '/logout', ({ req, res }) => {
  res.setHeader('set-cookie', clearSessionCookie(req));
  json(res, 200, { ok: true });
});

/* ---------------- feature routes (registered by modules) ---------------- */

import { registerClaudeRoutes } from './claude.ts';
import { registerCommentRoutes } from './comments.ts';
import { registerIdentityRoutes } from './identity.ts';
import { registerInboxRoutes, startInboxWatcher } from './obsidian.ts';
import { registerShareRoutes, startShareFollowing } from './share.ts';
import { startSnapshotWarmer } from './snapshot.ts';
import { registerSourceRoutes } from './source.ts';

registerSourceRoutes(on);
registerClaudeRoutes(on);
registerInboxRoutes(on);
registerCommentRoutes(on);
registerIdentityRoutes(on);
registerShareRoutes(on);

export type RouteRegistrar = typeof on;

/* ---------------- entry ---------------- */

/**
 * one-time server-side init, called (and awaited) by the integration at
 * astro:server:setup: pins the project root and the site hooks, resolves
 * the config and verifies the identity registry — a failure there throws,
 * so a misconfigured deployment fails dev startup loudly instead of serving
 * with broken auth. The inbox watcher is genuinely optional: its failure is
 * logged explicitly and does not stop the server.
 */
export function initWiki(root: string, opts: Omit<ApiOptions, 'root'> = {}): void {
  setProjectRoot(root);
  setSiteHooks(opts.markdown);
  wikiConfig();
  ensureRegistry();
  try {
    startInboxWatcher();
  } catch (err) {
    console.error('[wiki inbox] the watcher failed to start — inbox import is off for this run:', err);
  }
  // prewarm needs a share that can actually be created; an incomplete share
  // configuration is reported at share time (503), not by a build nobody can use
  const share = wikiConfig().share;
  if (share !== false && share.prewarm) {
    if (shareState() === 'ready') startSnapshotWarmer(root);
    else console.warn('[wiki share] prewarm is on but share is unconfigured (gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN) — not warming');
  }
  // shares follow their notes (a no-op while share is off/unconfigured or
  // followIdleMinutes is 0)
  startShareFollowing();
}

/** the request's own origins — both of them, when both exist:
 *  - the origin derived from the request (its public host): x-forwarded-host
 *    and -proto count only under `server.trustProxy`, since without a proxy
 *    those headers are client input and would let anyone mint an "own
 *    origin";
 *  - the configured external base URL when auth pins one (the canonical
 *    origin of the deployment's identity). It is NOT always where this
 *    server's pages are served from — an editing machine may borrow another
 *    host's SAML SP identity and still serve its own pages on its own
 *    subdomain, whose browser Origin must count as its own. */
function requestOrigins(req: IncomingMessage): string[] {
  const trustProxy = wikiConfig().server.trustProxy;
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = ((trustProxy ? req.headers['x-forwarded-host'] : undefined) ?? req.headers.host ?? '') as string;
  const derived = `${proto}://${host.split(',')[0]!.trim()}`;
  const configured = configuredBaseUrl();
  if (configured) {
    try {
      const pinned = new URL(configured).origin;
      return pinned === derived ? [derived] : [derived, pinned];
    } catch {
      /* malformed baseUrl is rejected at config resolution; fall through */
    }
  }
  return [derived];
}

/** the request's Origin header, falling back to the Referer's origin;
 *  null when absent or unparsable */
function originOf(req: IncomingMessage): string | null {
  if (req.headers.origin) return req.headers.origin;
  if (!req.headers.referer) return null;
  try {
    return new URL(req.headers.referer).origin;
  } catch {
    return null;
  }
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
): Promise<void> {
  setProjectRoot(opts.root);
  setSiteHooks(opts.markdown);
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname.replace(/^\/api\/wiki/, '') || '/';
  try {
    const matched = matchRoute(req.method ?? 'GET', path);
    if (!matched) return fail(res, 404, `no route: ${req.method} ${path}`);
    if (
      crossSiteBlocked({
        method: req.method ?? 'GET',
        path,
        origin: originOf(req),
        ownOrigins: requestOrigins(req),
        trustedOrigins: wikiConfig().auth.session.trustedOrigins,
      })
    ) {
      return fail(res, 403, 'Cross-site request refused');
    }
    const user = await sessionUser(req);
    const identity = identityConfig();
    if (matched.route.auth === 'admin') {
      if (!identity) return fail(res, 404, `no route: ${req.method} ${path}`);
      if (!user) return fail(res, 401, 'Sign in required');
      if (findIdentityUser(user.email)?.role !== identity.adminRole) return fail(res, 403, 'Admin only');
    } else if (matched.route.auth) {
      if (!user) return fail(res, 401, 'Sign in required');
      if (identity && !findIdentityUser(user.email)) return fail(res, 403, 'Not a member of this site');
    }
    await matched.route.handler({ req, res, params: matched.params, query: url.searchParams, user });
  } catch (err) {
    if (err instanceof HttpError) {
      console.warn(`[wiki api] ${req.method} ${path} → ${err.status}: ${err.message}`);
      if (!res.headersSent) fail(res, err.status, err.message);
      else res.end();
      return;
    }
    const id = randomUUID().slice(0, 8);
    console.error(`[wiki api] ${req.method} ${path} → 500 (${id})`, err);
    if (!res.headersSent) fail(res, 500, `Internal error (${id})`);
    else res.end();
  }
}
