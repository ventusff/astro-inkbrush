/**
 * Sessions + login providers.
 *
 * Session = stateless signed cookie, in one of two formats
 * (`auth.session.format` in inkbrush.config.ts):
 *  - hmac (default): HMAC-signed JSON payload (WikiUser + expiry), signing
 *    secret generated into .wiki/secret — single-site deployments, zero setup;
 *  - jwt: jose HS256 JWT with minimal claims {email, name?, picture?,
 *    provider} — roles are never in the token (looked up per request where
 *    needed). The secret is the AUTH_SECRET env var (startup error when
 *    missing); sites sharing the secret and a cookie Domain share the session.
 * Cookie name / Domain / TTL come from `auth.session` (defaults:
 * wiki_session, host-only, 30d hmac / 7d jwt); Secure is set when the
 * configured external baseUrl is https or the request arrived over https
 * (direct TLS or x-forwarded-proto).
 *
 * Providers (toggled per deployment in inkbrush.config.ts → auth):
 *  - dev:    quick login with any name/email — personal machines and
 *            private networks (`auth.dev`, default true).
 *  - google: OAuth2 authorization-code flow with PKCE (Google Workspace).
 *            Opt-in via `auth.google: {…}`; the client id/secret stay in env
 *            (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET). The authorization
 *            request is bound to the browser: a signed, single-use state
 *            and the PKCE verifier travel in a short-lived cookie, and the
 *            callback is accepted only from the browser that started it.
 *            Membership is restricted via `auth.google.allowedDomains`.
 *            The id_token is verified through Google's tokeninfo endpoint.
 *            Outside localhost the external base URL must be configured —
 *            the redirect URI is never derived from the Host header.
 *  - googleSaml: SAML SSO against a Google Workspace custom SAML app —
 *            see ./saml.ts (routes in ./index.ts).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { jwtVerify, SignJWT } from 'jose';

import type { GoogleAuthState, WikiUser } from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { HttpError } from './index.ts';
import { sessionSecret } from './store.ts';

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

/** shared attribute tail (Domain only when configured, Secure only over https) */
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

function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const match = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
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
  const value = cookieValue(req, conf.cookieName);
  if (!value) return null;

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
  if (!macEquals(value.slice(dot + 1), sign(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionPayload;
    if (parsed.exp < Date.now()) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

/** login return target: a site-relative path, or an absolute URL whose
 *  origin is listed in auth.session.trustedOrigins; anything else is `/`.
 *  A second character of `/` or `\` after the leading slash is an off-site
 *  jump (browsers normalise `\` to `/`), and a control character anywhere
 *  is stripped by browsers before navigation, so both are refused. */
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

/** the external origin the OAuth callback is registered under: the
 *  configured baseUrl, or the request host on localhost only */
function baseUrl(req: IncomingMessage): string {
  const google = wikiConfig().auth.google;
  if (google && google.baseUrl) return google.baseUrl;
  const host = req.headers.host ?? '';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return `http://${host}`;
  throw new HttpError(503, 'Google login needs auth.google.baseUrl (inkbrush.config.ts) outside localhost');
}

function redirectUri(req: IncomingMessage): string {
  return `${baseUrl(req)}/api/wiki/auth/google/callback`;
}

/* ---- the authorization request, bound to the browser that made it ----
 * state = b64url({ nonce, returnTo }) + '.' + HMAC; the nonce and the PKCE
 * verifier also sit in a short-lived cookie, so the callback is accepted
 * only from the browser that started the flow, and only once. */

const OAUTH_COOKIE = 'wiki_oauth';
const OAUTH_TTL_S = 600;

interface OAuthState {
  nonce: string;
  returnTo: string;
}

export interface OAuthStart {
  url: string;
  cookie: string;
}

/** the 302 target that starts the consent flow, plus the binding cookie */
export function googleAuthStart(req: IncomingMessage, returnTo: string): OAuthStart {
  const nonce = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const payload = b64url(Buffer.from(JSON.stringify({ nonce, returnTo } satisfies OAuthState)));
  const state = `${payload}.${sign(payload)}`;
  const params = new URLSearchParams({
    client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  // hint Google to show only workspace accounts of the first allowed domain
  const google = wikiConfig().auth.google;
  const domain = google === false ? undefined : google.allowedDomains.find((d) => !d.includes('@'));
  if (domain) params.set('hd', domain);
  const bound = b64url(Buffer.from(JSON.stringify({ nonce, verifier })));
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie: `${OAUTH_COOKIE}=${bound}.${sign(bound)}; ${cookieAttrs(OAUTH_TTL_S, req)}`,
  };
}

/** clears the binding cookie (the callback consumed it) */
export function clearOAuthCookie(req: IncomingMessage): string {
  return `${OAUTH_COOKIE}=; ${cookieAttrs(0, req)}`;
}

/** verify the callback's `state` against the binding cookie; returns the
 *  return target and the PKCE verifier, or throws */
export function googleAuthVerify(req: IncomingMessage, state: string | null): { returnTo: string; verifier: string } {
  const bound = cookieValue(req, OAUTH_COOKIE);
  if (!state || !bound) throw new Error('Sign-in was not started from this browser');
  const [sp, sm] = state.split('.');
  const [bp, bm] = bound.split('.');
  if (!sp || !sm || !bp || !bm || !macEquals(sm, sign(sp)) || !macEquals(bm, sign(bp))) {
    throw new Error('Sign-in state is invalid');
  }
  const parsedState = JSON.parse(Buffer.from(sp, 'base64url').toString()) as OAuthState;
  const parsedBound = JSON.parse(Buffer.from(bp, 'base64url').toString()) as { nonce: string; verifier: string };
  if (!parsedState.nonce || parsedState.nonce !== parsedBound.nonce) {
    throw new Error('Sign-in state does not match this browser');
  }
  return { returnTo: safeReturnUrl(parsedState.returnTo), verifier: parsedBound.verifier };
}

/** allowlist check: auth.google.allowedDomains = ['acme.com', 'bob@gmail.com'].
 *  Fail-closed: an empty list admits nobody; ['*'] admits every Google account. */
function emailAllowed(email: string, hd: string | undefined): boolean {
  const google = wikiConfig().auth.google;
  const rules = google === false ? [] : google.allowedDomains.map((s) => s.toLowerCase());
  if (rules.includes('*')) return true; // explicit allow-all
  if (rules.length === 0) return false; // no list configured → deny (fail-closed)
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] ?? '';
  return rules.some((rule) => rule === lower || rule === domain || rule === hd);
}

/** code → tokens → verified identity. Throws with a user-facing message. */
export async function googleExchangeCode(req: IncomingMessage, code: string, verifier: string): Promise<WikiUser> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
      client_secret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
      code_verifier: verifier,
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
