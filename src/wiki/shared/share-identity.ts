/**
 * What a share is, as a request describes it: the visibility with the
 * password or address that visibility calls for. One rule for creation and
 * for a change alike, shared by the server (which enforces it) and usable
 * by any client that wants to refuse early.
 */
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
 *  the message a 400 answers with. No visibility means password, the shape
 *  older clients send. */
export function parseIdentity(body: { visibility?: unknown; password?: unknown; alias?: unknown }): ShareIdentity | string {
  const visibility = body.visibility === undefined ? 'password' : body.visibility;
  if (!isShareVisibility(visibility)) return 'visibility must be password, link or public';
  if (body.password !== undefined && typeof body.password !== 'string') return 'password must be a string';
  if (body.alias !== undefined && typeof body.alias !== 'string') return 'alias must be a string';
  const password = body.password ?? '';
  const alias = (body.alias ?? '').trim();
  if (visibility === 'password') {
    if (password.length < 6) return 'Password must be at least 6 characters';
  } else if (password) {
    return `A ${visibility} share carries no password`;
  }
  if (alias) {
    if (visibility !== 'public') return 'Only a public share can have an address';
    if (!validAlias(alias)) return 'Address: lowercase letters, digits and inner hyphens, up to 64 characters';
  }
  return { visibility, password, alias: alias || null };
}
