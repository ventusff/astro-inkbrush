/**
 * A public share's readable address. One to 64 lowercase letters, digits and
 * inner hyphens — the shape a gateway path segment carries safely, and the
 * shape the gateway enforces. The default alias is the note id in that shape.
 * Browser-safe: the share popover validates with the same rule the server
 * applies.
 */
export const ALIAS_MAX = 64;

const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function validAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

/** the note id as an alias: lowercased, every run of other characters one
 *  hyphen, no hyphen at either end, cut to the maximum length */
export function aliasFor(noteId: string): string {
  return noteId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, ALIAS_MAX)
    .replace(/-+$/, '');
}
