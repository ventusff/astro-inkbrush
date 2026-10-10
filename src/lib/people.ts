/**
 * people — who a member is, across every place a person shows up: the
 * identity registry's records (users.json), the authors of git commits,
 * frontmatter `authors`, and `@handle` mentions in note text (subpath export
 * astro-inkbrush/people; browser-safe, no Node imports).
 *
 * A member's handle is what follows `@` in a mention. It is kept on the
 * record once assigned, so it never changes under anyone's mentions — not
 * when someone joins, leaves or is renamed. A record without one is given
 * one, in registry order: the email's local part, lowercased and reduced to
 * the mention grammar's characters (`Jane.Doe+wiki@team.com` → `jane.doe-wiki`);
 * when an earlier member holds that already, the domain's first label is
 * added (`jane.doe.lab`), and a number when that is taken too.
 *
 * `identify` maps a trace of a person to the member: an email (the
 * member's own or one of their `aliases` — their other accounts and commit
 * addresses), else a handle; a name counts only where no real address speaks for
 * the person — a frontmatter author, or a commit under a placeholder address
 * such as `wiki@local` — so an unknown address never borrows a member's name.
 */

/** the registry fields people resolution reads (IdentityUser carries more) */
export interface PersonRecord {
  email: string;
  name: string;
  handle?: string | undefined;
  aliases?: readonly string[] | undefined;
}

export interface Person {
  handle: string;
  name: string;
  email: string;
  /** the member's other addresses: other accounts of theirs, the addresses on their commits */
  aliases: string[];
}

/** a handle as written after `@`: letters, digits, `.`, `_`, `-`, starting and ending with a letter or digit */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const lower = (s: string): string => s.trim().toLowerCase();

/** `jane.doe@team.com` → `jane.doe` (an address without `@` is its own local part) */
export function localPart(email: string): string {
  const e = lower(email);
  const at = e.lastIndexOf('@');
  return at === -1 ? e : e.slice(0, at);
}

/** text reduced to the handle grammar: lowercased, other characters as `-`, no leading or trailing punctuation */
function handleText(text: string): string {
  return lower(text)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/** the handle every member has: the one kept on the record, else one given in registry order (see the module comment) */
export function peopleOf(records: readonly PersonRecord[]): Person[] {
  // kept handles first: one stays its member's even when an earlier record has none yet
  const taken = new Set<string>();
  const handles = records.map((r) => {
    const kept = r.handle && HANDLE_RE.test(r.handle) && !taken.has(r.handle) ? r.handle : undefined;
    if (kept) taken.add(kept);
    return kept;
  });
  return records.map((r, i) => {
    const email = lower(r.email);
    let handle = handles[i];
    if (!handle) {
      const local = handleText(localPart(email)) || 'member';
      const label = handleText(email.slice(email.lastIndexOf('@') + 1).split('.')[0] ?? '');
      handle = local;
      if (taken.has(handle) && label) handle = `${local}.${label}`;
      for (let n = 2; taken.has(handle); n += 1) handle = `${local}.${label || 'member'}${n}`;
      taken.add(handle);
    }
    return { handle, name: r.name.trim() || localPart(email), email, aliases: (r.aliases ?? []).map(lower) };
  });
}

export interface PeopleIndex {
  readonly all: readonly Person[];
  byHandle(handle: string): Person | undefined;
  /** the member whose own address this is */
  member(email: string): Person | undefined;
  /** the member whose own address or other address this is */
  byEmail(email: string): Person | undefined;
  /** the member behind a trace of a person (see the module comment); undefined for a stranger */
  identify(who: { email?: string | undefined; name?: string | undefined; handle?: string | undefined }): Person | undefined;
}

/** an address that names nobody: no domain with a dot, such as `wiki@local` */
const isPlaceholder = (email: string): boolean => !/@[^@\s]+\.[^@\s]+$/.test(email);

export function peopleIndex(records: readonly PersonRecord[]): PeopleIndex {
  const all = peopleOf(records);
  const handles = new Map(all.map((p) => [p.handle, p]));
  const own = new Map(all.map((p) => [p.email, p]));
  const emails = new Map(own);
  for (const p of all) for (const a of p.aliases) if (!emails.has(a)) emails.set(a, p);
  const names = new Map<string, Person>();
  for (const p of all) if (!names.has(lower(p.name))) names.set(lower(p.name), p);
  const byHandle = (handle: string) => handles.get(lower(handle).replace(/^@/, ''));
  const byEmail = (email: string) => emails.get(lower(email));
  return {
    all,
    byHandle,
    member: (email) => own.get(lower(email)),
    byEmail,
    identify({ email, name, handle }) {
      if (email) {
        const found = byEmail(email);
        if (found || !isPlaceholder(lower(email))) return found;
      }
      return (handle ? byHandle(handle) : undefined) ?? (name ? (byHandle(name) ?? names.get(lower(name))) : undefined);
    },
  };
}
