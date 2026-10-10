/**
 * Identity registry record validation — one rule set for both directions:
 * what the admin PUT may write is also what a users.json read from disk must
 * satisfy. Kept free of config/server imports so it is unit-testable.
 */
import { peopleOf } from '../../lib/people.ts';
import { englishOf, failure, type WikiFailure } from '../shared/errors.ts';
import type { IdentityUser } from '../shared/types.ts';

/** validation failures the API maps to 400 (vs unexpected errors → 500) */
export class IdentityValidationError extends Error {
  readonly failure: WikiFailure;
  constructor(f: WikiFailure) {
    super(englishOf(f));
    this.name = 'IdentityValidationError';
    this.failure = f;
  }
}

/** longest member name: one line in a byline, a mention, a comment header */
export const NAME_MAX = 60;

/** characters a name may not carry: angle brackets (git reads `<` as the
 *  start of an address), control characters (line breaks, NUL — git and the
 *  shell reject them) and the bidirectional overrides that would let a name
 *  reverse the text around it */
const NAME_FORBIDDEN = /[<>\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** a member name as stored: trimmed, one line of at most NAME_MAX characters, nothing NAME_FORBIDDEN */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > NAME_MAX || NAME_FORBIDDEN.test(name)) return null;
  return name;
}

const isEmail = (s: string): boolean => /^[^\s@<>]+@[^\s@<>]+$/.test(s);

/**
 * Validate and normalize a users list — one rule set for both directions,
 * read two ways. Fields that grant access are refused the same way on
 * either side: each record an object with an email (lowercased), a role
 * from the configured vocabulary, no email twice. Fields that only name a
 * person are refused on a write and mended on a read (`lenient`), so a hand
 * edit that breaks one name never takes the site down: a name (one line, at
 * most NAME_MAX characters, nothing NAME_FORBIDDEN; a blank one is the
 * email prefix) falls back to the email prefix, and an other address
 * (`aliases`: lowercased, deduplicated, owned by one member only) that is
 * not an address or is someone else's is dropped.
 *
 * Every record leaves with its handle (lib/people.ts): the one it keeps, or
 * one given in registry order — the first write after a member is added
 * fixes theirs for good. Throws IdentityValidationError on the first refusal.
 */
export function validateUserRecords(input: unknown, roles: string[], { lenient = false }: { lenient?: boolean } = {}): IdentityUser[] {
  if (!Array.isArray(input)) {
    throw new IdentityValidationError(failure('bad-request', { detail: 'users must be an array' }));
  }
  /** address → the member it belongs to */
  const owners = new Map<string, string>();
  const records = input.map((entry): IdentityUser => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new IdentityValidationError(failure('bad-request', { detail: 'each user must be an object with email/name/role' }));
    }
    const rec = entry as Partial<IdentityUser>;
    const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
    if (!isEmail(email)) {
      throw new IdentityValidationError(failure('members-email', { email: String(rec.email ?? '') }));
    }
    if (owners.has(email)) {
      throw new IdentityValidationError(failure('members-duplicate', { email }));
    }
    owners.set(email, email);
    const role = typeof rec.role === 'string' ? rec.role : '';
    if (!roles.includes(role)) {
      throw new IdentityValidationError(failure('members-role', { role, roles }));
    }
    const prefix = email.split('@')[0] ?? email;
    const blank = rec.name === undefined || (typeof rec.name === 'string' && rec.name.trim() === '');
    const name = blank ? prefix : (cleanName(rec.name) ?? (lenient ? prefix : null));
    if (name === null) throw new IdentityValidationError(failure('members-name', { email, max: NAME_MAX }));
    const aliases: string[] = [];
    for (const raw of Array.isArray(rec.aliases) ? rec.aliases : []) {
      const alias = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (!isEmail(alias)) {
        if (lenient) continue;
        throw new IdentityValidationError(failure('members-alias', { email, alias: String(raw) }));
      }
      if (alias !== email && !aliases.includes(alias)) aliases.push(alias);
    }
    const handle = typeof rec.handle === 'string' ? rec.handle : undefined;
    return { email, name, role, ...(handle ? { handle } : {}), ...(aliases.length > 0 ? { aliases } : {}) };
  });
  for (const u of records) {
    const kept: string[] = [];
    for (const alias of u.aliases ?? []) {
      const owner = owners.get(alias);
      if (owner !== undefined && owner !== u.email) {
        if (lenient) continue;
        throw new IdentityValidationError(failure('members-alias-taken', { alias, owner }));
      }
      owners.set(alias, u.email);
      kept.push(alias);
    }
    if (u.aliases) {
      if (kept.length > 0) u.aliases = kept;
      else delete u.aliases;
    }
  }
  const people = peopleOf(records);
  return records.map((u, i) => ({ email: u.email, name: u.name, role: u.role, handle: people[i]!.handle, ...(u.aliases ? { aliases: u.aliases } : {}) }));
}
