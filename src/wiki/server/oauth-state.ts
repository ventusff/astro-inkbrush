/**
 * OAuth authorization state: an HMAC-signed payload carrying the browser
 * nonce, the login return target and the issue time. A state is valid for
 * ten minutes and is consumable once — the single-use registry is
 * in-memory, so a server restart forgets consumed states; the issue-time
 * window bounds a replay across restarts to those ten minutes. Kept free
 * of config/server imports (the caller supplies the signing secret) so
 * expiry and replay are unit-testable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface OAuthStatePayload {
  /** binds the callback to the browser that started the flow (cookie pair) */
  nonce: string;
  returnTo: string;
  /** issue time (ms since epoch); the state expires OAUTH_STATE_TTL_MS later */
  iat: number;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

function mac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `b64url(json)`.`mac` — the `state` query parameter of the consent URL */
export function encodeOAuthState(payload: OAuthStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/**
 * Verify and decode a state parameter: the MAC must match, the payload must
 * carry a string nonce and a finite iat, and the iat must be within the
 * TTL window (a future iat beyond clock skew is invalid too). Throws with
 * a user-facing message on any violation.
 */
export function decodeOAuthState(state: string, secret: string, now: number): OAuthStatePayload {
  const dot = state.indexOf('.');
  const body = dot >= 0 ? state.slice(0, dot) : '';
  const sig = dot >= 0 ? state.slice(dot + 1) : '';
  if (!body || !sig || !macEquals(sig, mac(body, secret))) {
    throw new Error('Sign-in state is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    throw new Error('Sign-in state is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Sign-in state is invalid');
  const { nonce, returnTo, iat } = parsed as Partial<OAuthStatePayload>;
  if (typeof nonce !== 'string' || !nonce || typeof iat !== 'number' || !Number.isFinite(iat)) {
    throw new Error('Sign-in state is invalid');
  }
  if (iat > now + 60_000 || now - iat > OAUTH_STATE_TTL_MS) {
    throw new Error('Sign-in took too long — start again');
  }
  return { nonce, returnTo: typeof returnTo === 'string' ? returnTo : '', iat };
}

/**
 * A capped consume-once registry. `consume` returns true the first time an
 * id is presented and false on every later presentation; beyond the cap the
 * oldest ids are evicted (an evicted id is older than the state TTL long
 * before the cap is realistically reached).
 */
export function createSingleUse(cap = 1000): { consume(id: string): boolean } {
  const seen = new Set<string>();
  return {
    consume(id) {
      if (seen.has(id)) return false;
      if (seen.size >= cap) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.add(id);
      return true;
    },
  };
}
