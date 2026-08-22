/**
 * /api/wiki/* — connect-style middleware entry, loaded through
 * `server.ssrLoadModule` by the wiki integration (so it gets HMR in dev).
 *
 * Tiny hand-rolled router: no framework, ~all handlers are small async
 * functions over Node's raw req/res. Streaming endpoints (claude) write
 * NDJSON chunks to the response directly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MeResponse, WikiUser } from '../shared/types';
import {
  clearSessionCookie,
  createSessionCookie,
  devLoginEnabled,
  googleAuthUrl,
  googleExchangeCode,
  googleState,
  safeReturnUrl,
  sessionUser,
} from './auth';
import { wikiConfig } from './config';
import {
  addUserIfAbsent as addIdentityUserIfAbsent,
  findUser as findIdentityUser,
  identityConfig,
} from './identity';
import { buildSaml, displayNameFromProfile, googleSamlState, samlEmailAllowed } from './saml';
import { shareState } from './share';
import { setProjectRoot } from './store';

export interface ApiOptions {
  root: string;
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

function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const segs = path.split('/').filter(Boolean);
  outer: for (const route of routes) {
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.parts.length; i++) {
      const part = route.parts[i]!;
      if (part.startsWith('*')) {
        if (i >= segs.length) continue outer;
        params[part.slice(1)] = segs.slice(i).map(decodeURIComponent).join('/');
        return { route, params };
      }
      const seg = segs[i];
      if (seg === undefined) continue outer;
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(seg);
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

/** request body ceiling — /auth/dev and the SAML ACS are public, so an
 *  unbounded reader is a free memory-exhaustion primitive. Every current
 *  endpoint posts small JSON (biggest: a note's markdown), 1 MiB is generous. */
export const BODY_LIMIT = 1024 * 1024;

/** buffer the request body with a hard ceiling; over the limit ⇒ 413.
 *  The stream is only paused (never destroyed) on overflow: destroying an
 *  IncomingMessage tears down the socket, and the 413 would never be sent. */
async function readCapped(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  const declared = Number(req.headers['content-length']);
  const tooBig = (): HttpError =>
    new HttpError(413, `Request body too large (max ${limit} bytes)`);
  if (Number.isFinite(declared) && declared > limit) throw tooBig();
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
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

export async function readBody<T>(req: IncomingMessage): Promise<T> {
  const text = await readCapped(req);
  if (!text) return {} as T;
  return JSON.parse(text) as T;
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

on('GET', '/me', ({ user, res }) => {
  const identity = identityConfig();
  const record = identity && user ? findIdentityUser(user.email) : null;
  const body: MeResponse = {
    user,
    providers: { dev: devLoginEnabled(), google: googleState(), googleSaml: googleSamlState() },
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
  if (!devLoginEnabled()) return fail(res, 403, 'Dev login is disabled (inkbrush.config.ts → auth.dev)');
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
  res.statusCode = 302;
  // same sanitising as the SAML login route — the return target is echoed back
  // to us as `state` and turned into a Location header at the callback
  res.setHeader('location', googleAuthUrl(req, safeReturnUrl(query.get('return'))));
  res.end();
});

on('GET', '/auth/google/callback', async ({ req, res, query }) => {
  const code = query.get('code');
  if (!code) return fail(res, 400, 'missing code');
  try {
    const user = await googleExchangeCode(req, code);
    res.setHeader('set-cookie', await createSessionCookie(user, req));
    res.statusCode = 302;
    // `state` round-trips through the IdP ⇒ attacker-controlled: same
    // whitelist as the SAML callback (a bare startsWith('/') would wave
    // //evil.com through)
    res.setHeader('location', safeReturnUrl(query.get('state')));
    res.end();
  } catch (err) {
    fail(res, 403, err instanceof Error ? err.message : 'Google sign-in failed');
  }
});

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

    // when the identity module is on: first login auto-registers with
    // defaultRole (an existing registry name wins over the SAML profile name)
    if (identityConfig()) {
      const record = addIdentityUserIfAbsent(email, name);
      if (record.name.trim()) name = record.name;
    }

    const user: WikiUser = { name, email, provider: 'google-saml' };
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

import { registerClaudeRoutes } from './claude';
import { registerCommentRoutes } from './comments';
import { registerIdentityRoutes } from './identity';
import { registerInboxRoutes, startInboxWatcher } from './obsidian';
import { registerShareRoutes } from './share';
import { registerSourceRoutes } from './source';

registerSourceRoutes(on);
registerClaudeRoutes(on);
registerInboxRoutes(on);
registerCommentRoutes(on);
registerIdentityRoutes(on);
registerShareRoutes(on);

export type RouteRegistrar = typeof on;

/* ---------------- entry ---------------- */

/**
 * one-time server-side init, called by the integration at astro:server:setup:
 * pins the project root, then starts whatever the deployment config enables
 * (currently just the optional Obsidian inbox watcher).
 */
export function initWiki(root: string): void {
  setProjectRoot(root);
  // resolve the config eagerly so misconfiguration (e.g. session.format 'jwt'
  // without AUTH_SECRET) fails loudly at startup, not on the first request
  wikiConfig();
  startInboxWatcher();
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
): Promise<void> {
  setProjectRoot(opts.root);
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname.replace(/^\/api\/wiki/, '') || '/';
  const matched = matchRoute(req.method ?? 'GET', path);
  if (!matched) return fail(res, 404, `no route: ${req.method} ${path}`);
  // the auth gate lives INSIDE the try: it touches the session and the identity
  // registry, both of which may throw (corrupt users.json ⇒ loud refusal)
  try {
    const user = await sessionUser(req);
    if (matched.route.auth === 'admin') {
      // admin surface only exists when the identity module is on
      if (!identityConfig()) return fail(res, 404, `no route: ${req.method} ${path}`);
      if (!user) return fail(res, 401, 'Sign in required');
      const record = findIdentityUser(user.email);
      if (record?.role !== identityConfig()?.adminRole) {
        return fail(res, 403, 'Admin only');
      }
    } else if (matched.route.auth && !user) {
      return fail(res, 401, 'Sign in required');
    }
    await matched.route.handler({ req, res, params: matched.params, query: url.searchParams, user });
  } catch (err) {
    if (err instanceof HttpError) {
      console.warn(`[wiki api] ${req.method} ${path} → ${err.status}: ${err.message}`);
      if (!res.headersSent) fail(res, err.status, err.message);
      else res.end();
      return;
    }
    console.error('[wiki api]', err);
    if (!res.headersSent) fail(res, 500, err instanceof Error ? err.message : 'internal error');
    else res.end();
  }
}
