/**
 * Shape validation of an hmac-session cookie payload. The MAC proves the
 * server minted the bytes; this proves the bytes still are a session —
 * expiry a finite future timestamp, user fields strings of sane length,
 * provider from the known set. Kept free of config/server imports so the
 * rules are unit-testable.
 */
import type { WikiUser } from '../shared/types.ts';

const PROVIDERS = new Set(['dev', 'google', 'google-saml']);
/** RFC 5321 caps the address at 254 octets; 320 leaves headroom for i18n */
const MAX_EMAIL = 320;
const MAX_NAME = 200;
const MAX_PICTURE = 2048;

/**
 * The session's user when `parsed` is a valid, unexpired payload
 * (`{ user, exp }`); null otherwise.
 */
export function sessionPayloadUser(parsed: unknown, now: number): WikiUser | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { user, exp } = parsed as { user?: unknown; exp?: unknown };
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < now) return null;
  if (typeof user !== 'object' || user === null) return null;
  const { name, email, picture, provider } = user as Record<string, unknown>;
  if (typeof email !== 'string' || !email.includes('@') || email.length > MAX_EMAIL) return null;
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) return null;
  if (typeof provider !== 'string' || !PROVIDERS.has(provider)) return null;
  if (picture !== undefined && (typeof picture !== 'string' || picture.length > MAX_PICTURE)) return null;
  return {
    name,
    email,
    ...(typeof picture === 'string' && picture ? { picture } : {}),
    provider: provider as WikiUser['provider'],
  };
}
