/**
 * Identity registry record validation — one rule set for both directions:
 * what the admin PUT may write is also what a users.json read from disk must
 * satisfy. Kept free of config/server imports so it is unit-testable.
 */
import type { IdentityUser } from '../shared/types.ts';

/** validation failures the API maps to 400 (vs unexpected errors → 500) */
export class IdentityValidationError extends Error {}

/**
 * Validate and normalize an untrusted users list: an array of objects, each
 * with an email containing '@' (lowercased), a role from the configured
 * vocabulary, and no duplicate emails; a blank name falls back to the email
 * prefix. Throws IdentityValidationError on the first violation.
 */
export function validateUserRecords(input: unknown, roles: string[]): IdentityUser[] {
  if (!Array.isArray(input)) {
    throw new IdentityValidationError('users must be an array');
  }
  const seen = new Set<string>();
  return input.map((entry): IdentityUser => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new IdentityValidationError('each user must be an object with email/name/role');
    }
    const rec = entry as Partial<IdentityUser>;
    const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
    if (!email.includes('@')) {
      throw new IdentityValidationError(`invalid email: '${String(rec.email ?? '')}'`);
    }
    if (seen.has(email)) {
      throw new IdentityValidationError(`duplicate email: ${email}`);
    }
    seen.add(email);
    const role = typeof rec.role === 'string' ? rec.role : '';
    if (!roles.includes(role)) {
      throw new IdentityValidationError(`unknown role '${role}' (allowed: ${roles.join(', ')})`);
    }
    const name =
      typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : (email.split('@')[0] ?? email);
    return { email, name, role };
  });
}
