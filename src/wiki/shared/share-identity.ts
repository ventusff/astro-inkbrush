/**
 * What a share is, as a request describes it: the visibility with the
 * password or address that visibility calls for. One rule for creation and
 * for a change alike, shared by the server (which enforces it) and usable
 * by any client that wants to refuse early.
 */
import { failure, type WikiFailure } from './errors.ts';
import { validAlias } from './share-alias.ts';
import type { ShareVisibility } from './types.ts';

export interface ShareIdentity {
  visibility: ShareVisibility;
  /** the plaintext, for a password share only — hashed before it leaves */
  password: string;
  alias: string | null;
}

export const VISIBILITIES: readonly string[] = ['password', 'link', 'public'];

export function isShareVisibility(value: unknown): value is ShareVisibility {
  return typeof value === 'string' && VISIBILITIES.includes(value);
}

/** the request's identity — a password of at least 6 characters with
 *  'password', an optional alias in the gateway's shape with 'public' — or
 *  the failure a 400 answers with. No visibility means password, the shape
 *  older clients send. */
export function parseIdentity(body: { visibility?: unknown; password?: unknown; alias?: unknown }): ShareIdentity | WikiFailure {
  const visibility = body.visibility === undefined ? 'password' : body.visibility;
  if (!isShareVisibility(visibility)) return failure('bad-request', { detail: 'visibility must be password, link or public' });
  if (body.password !== undefined && typeof body.password !== 'string') return failure('bad-request', { detail: 'password must be a string' });
  if (body.alias !== undefined && typeof body.alias !== 'string') return failure('bad-request', { detail: 'alias must be a string' });
  const password = body.password ?? '';
  const alias = (body.alias ?? '').trim();
  if (visibility === 'password') {
    if (password.length < 6) return failure('share-password-short');
  } else if (password) {
    return failure('share-password-unexpected', { visibility });
  }
  if (alias) {
    if (visibility !== 'public') return failure('share-alias-not-public');
    if (!validAlias(alias)) return failure('share-alias-invalid');
  }
  return { visibility, password, alias: alias || null };
}
