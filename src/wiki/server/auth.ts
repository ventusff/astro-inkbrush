/**
 * Sessions + login providers.
 *
 * Session = stateless signed cookie, in one of two formats
 * (`auth.session.format` in inkbrush.config.ts):
 *  - hmac (default): HMAC-signed JSON payload (WikiUser + expiry), signing
 *    secret generated into .wiki/secret — single-site deployments, zero setup;
 *  - jwt: jose HS256 JWT with minimal claims {email, name?, picture?,
 *    provider} — roles are NEVER in the token (looked up per request where
 *    needed). Secret comes from the AUTH_SECRET env var (required — startup
 *    error when missing), so multiple sites sharing the secret + a shared
 *    cookie Domain get site-wide SSO.
 * Cookie name / Domain / TTL come from `auth.session` (defaults keep the
 * historical shape: wiki_session, host-only, 30d hmac / 7d jwt); Secure is
 * set when the configured external baseUrl is https, or when the request
 * itself arrived over https (direct TLS or x-forwarded-proto) — covers
 * dev-login-only https deployments that never configure a baseUrl.
 *
 * Providers (toggled per-deployment in inkbrush.config.ts → auth):
 *  - dev:    quick login with any name/email — personal-intranet / local
 *            testing flavour (`auth.dev`, default true).
 *  - google: full OAuth2 authorization-code flow (Google Workspace). Opt-in
 *            via `auth.google: {…}`; the client id/secret stay in env
 *            (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET — secrets never enter
 *            the config file). Membership is restricted via
 *            `auth.google.allowedDomains` (domains and/or full addresses).
 *            The id_token is verified through Google's tokeninfo endpoint
 *            (signature checked on Google's side).
 *  - googleSaml: SAML SSO against a Google Workspace custom SAML app —
 *            see ./saml.ts (routes in ./index.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { jwtVerify, SignJWT } from 'jose';

import type { GoogleAuthState, WikiUser } from '../shared/types';
import { wikiConfig } from './config';
import { sessionSecret } from './store';

/* ---------------- signed cookie session ---------------- */

interface SessionPayload {
  user: WikiUser;
  exp: number;
}

function sessionConf(): ReturnType<typeof wikiConfig>['auth']['session'] {
  return wikiConfig().auth.session;
}

/** external base URL of this deployment as configured (SAML first, then
 *  Google) — null when neither provider pins one (plain local dev) */
function configuredBaseUrl(): string | null {
  const auth = wikiConfig().auth;
  if (auth.googleSaml !== false && auth.googleSaml.baseUrl) return auth.googleSaml.baseUrl;
  if (auth.google !== false && auth.google.baseUrl) return auth.google.baseUrl;
  return null;
}

/** https detection: direct TLS, or the reverse proxy's x-forwarded-proto (traefik/nginx) */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https';
}

/** shared attribute tail — plain http dev output stays byte-identical to the
 *  historical cookie (no Domain, no Secure) */
function cookieAttrs(maxAgeS: number, req: IncomingMessage): string {
  const conf = sessionConf();
  let attrs = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
  if (conf.cookieDomain) attrs += `; Domain=${conf.cookieDomain}`;
  if (configuredBaseUrl()?.startsWith('https://') || isSecureRequest(req)) attrs += '; Secure';
  return attrs;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(data: string): string {
  return createHmac('sha256', sessionSecret()).update(data).digest('base64url');
}

/** jwt-mode signing key (AUTH_SECRET) — presence is validated at config
 *  resolution, this guard covers direct callers only */
function jwtKey(): Uint8Array {
  const secret = process.env['AUTH_SECRET'];
  if (!secret) throw new Error('AUTH_SECRET environment variable missing (required for jwt sessions)');
  return new TextEncoder().encode(secret);
}

export async function createSessionCookie(user: WikiUser, req: IncomingMessage): Promise<string> {
  const conf = sessionConf();
  const maxAgeS = conf.ttlDays * 24 * 3600;
  let value: string;
  if (conf.format === 'jwt') {
    value = await new SignJWT({
      email: user.email,
      ...(user.name ? { name: user.name } : {}),
      ...(user.picture ? { picture: user.picture } : {}),
      provider: user.provider,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${maxAgeS}s`)
      .sign(jwtKey());
  } else {
    const payload = b64url(
      Buffer.from(
        JSON.stringify({ user, exp: Date.now() + maxAgeS * 1000 } satisfies SessionPayload),
      ),
    );
    value = `${payload}.${sign(payload)}`;
  }
  return `${conf.cookieName}=${value}; ${cookieAttrs(maxAgeS, req)}`;
}

export function clearSessionCookie(req: IncomingMessage): string {
  const conf = sessionConf();
  return `${conf.cookieName}=; ${cookieAttrs(0, req)}`;
}

export async function sessionUser(req: IncomingMessage): Promise<WikiUser | null> {
  const conf = sessionConf();
  const cookies = req.headers.cookie ?? '';
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(`${conf.cookieName}=`));
  if (!match) return null;
  const value = match.slice(conf.cookieName.length + 1);

  if (conf.format === 'jwt') {
    try {
      const { payload } = await jwtVerify(value, jwtKey(), { algorithms: ['HS256'] });
      const email = typeof payload['email'] === 'string' ? payload['email'] : null;
      if (!email) return null;
      const name = typeof payload['name'] === 'string' && payload['name'].trim() ? payload['name'] : null;
      const provider = payload['provider'];
      return {
        // token may omit the name — fall back to the email prefix
        name: name ?? email.split('@')[0] ?? email,
        email,
        ...(typeof payload['picture'] === 'string' && payload['picture']
          ? { picture: payload['picture'] }
          : {}),
        provider:
          provider === 'google' || provider === 'google-saml' || provider === 'dev' ? provider : 'dev',
      };
    } catch {
      return null;
    }
  }

  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionPayload;
    if (parsed.exp < Date.now()) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

/** login return target: relative paths are always allowed; absolute URLs only
 *  when their origin is whitelisted in auth.session.trustedOrigins
 *  (open-redirect guard)
 *
 *  The two guards below look paranoid — they are not, do NOT "simplify" them:
 *   - browsers normalise backslashes to slashes while parsing a URL, so
 *     `Location: /\evil.com` navigates to https://evil.com/ exactly like the
 *     protocol-relative `//evil.com` does — any slash-ish second character is
 *     an off-site jump, not a site-relative path;
 *   - browsers also strip control characters (TAB/CR/LF) from URLs, so a
 *     `/<TAB>/evil.com` sent through a header would collapse into `//evil.com`.
 */
export function safeReturnUrl(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  if (raw.startsWith('/')) {
    const second = raw[1];
    return second === '/' || second === '\\' ? '/' : raw;
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      sessionConf().trustedOrigins.includes(url.origin)
    ) {
      return raw;
    }
  } catch {
    /* not a URL */
  }
  return '/';
}

/* ---------------- providers ---------------- */

export function devLoginEnabled(): boolean {
  return wikiConfig().auth.dev;
}

/** off = disabled in inkbrush.config.ts · ready = usable · unconfigured = enabled
 *  in config but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in env */
export function googleState(): GoogleAuthState {
  if (wikiConfig().auth.google === false) return 'off';
  const hasSecrets = Boolean(process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']);
  return hasSecrets ? 'ready' : 'unconfigured';
}

function baseUrl(req: IncomingMessage): string {
  const google = wikiConfig().auth.google;
  if (google && google.baseUrl) return google.baseUrl;
  const host = req.headers.host ?? 'localhost:4321';
  return `http://${host}`;
}

function redirectUri(req: IncomingMessage): string {
  return `${baseUrl(req)}/api/wiki/auth/google/callback`;
}

/** allowlist check: auth.google.allowedDomains = ['acme.com', 'bob@gmail.com'].
 *  Fail-closed: an empty list admits NOBODY. (It used to admit any Google
 *  account — a fail-open login gate is an incident waiting to happen; to
 *  really admit everyone you must write ['*'] explicitly.) */
function emailAllowed(email: string, hd: string | undefined): boolean {
  const google = wikiConfig().auth.google;
  const rules = google === false ? [] : google.allowedDomains.map((s) => s.toLowerCase());
  if (rules.includes('*')) return true; // explicit allow-all
  if (rules.length === 0) return false; // no list configured → deny (fail-closed)
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] ?? '';
  return rules.some((rule) => rule === lower || rule === domain || rule === hd);
}

/** 302 target that starts the Google Workspace consent flow */
export function googleAuthUrl(req: IncomingMessage, returnTo: string): string {
  const params = new URLSearchParams({
    client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: returnTo,
    prompt: 'select_account',
  });
  // hint Google to show only workspace accounts of the first allowed domain
  const google = wikiConfig().auth.google;
  const domain = google === false ? undefined : google.allowedDomains.find((d) => !d.includes('@'));
  if (domain) params.set('hd', domain);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** code → tokens → verified identity. Throws with a user-facing message. */
export async function googleExchangeCode(req: IncomingMessage, code: string): Promise<WikiUser> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
      client_secret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('Google returned no id_token');

  // verify signature + audience via Google's tokeninfo endpoint
  const infoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`,
  );
  if (!infoRes.ok) throw new Error('id_token verification failed');
  const info = (await infoRes.json()) as {
    aud?: string;
    email?: string;
    email_verified?: string;
    name?: string;
    picture?: string;
    hd?: string;
  };
  if (info.aud !== process.env['GOOGLE_CLIENT_ID']) throw new Error('id_token audience mismatch');
  if (!info.email || info.email_verified !== 'true') throw new Error('Google email not verified');
  if (!emailAllowed(info.email, info.hd)) {
    throw new Error(`Account ${info.email} is not in an allowed Workspace domain`);
  }
  return {
    name: info.name ?? info.email,
    email: info.email,
    ...(info.picture ? { picture: info.picture } : {}),
    provider: 'google',
  };
}
