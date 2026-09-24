/**
 * syndication-bundle — the unit of syndication and its digest.
 *
 * A unit is a top-level note with everything under its directory (hub
 * sub-pages, demo modules, attachments) plus the same directory under
 * every locale prefix: `chasing/`, `en/chasing/`, `de/chasing/`. It is
 * identified by its top-level id and exists iff its default-locale root
 * note `<unit>/index.{md,mdx}` exists. A bundle is the unit's files keyed
 * by content-root-relative POSIX path, each with its bytes and its git
 * tree mode — a file is its content and whether it is executable; the
 * same paths hold on the peer (a copy lives at exactly the id its
 * original has).
 *
 * The digest is the revision two wikis compare: sixteen hex characters of
 * a SHA-256 over the sorted (path, part) pairs. A file's part is its
 * content part — for a note file the SHA-256 of its canonical text, the
 * frontmatter as sorted JSON without the `origin` block then the body
 * byte-exact; for any other file its git blob id — prefixed by its mode
 * when the mode is not the plain file's: `100755:<content part>` for an
 * executable file. Consequences: a reformatted frontmatter or a stamped
 * `origin` block never changes the digest; a changed body, attachment,
 * module or executable bit always does; and a peer computes the same
 * digest from a git tree listing without fetching the large blobs.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { CopyOrigin } from '../wiki/shared/types.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { checkBranchName } from './git-ref-name.ts';
import { NOTE_ID } from './note-id.ts';
import { localePrefixOf } from './wikilink-core.ts';

/** the git tree mode of a regular file: plain, or executable */
export type FileMode = '100644' | '100755';

/** the mode of a plain file: the one mode that leaves a digest part unprefixed */
export const PLAIN_FILE: FileMode = '100644';

/** a unit file: its bytes and its git tree mode */
export interface UnitFile {
  bytes: Uint8Array;
  mode: FileMode;
}

/** content-root-relative POSIX path → the file */
export type Bundle = Map<string, UnitFile>;

/** `mode` is a regular file's (a symlink's or a submodule's is not) */
export function isFileMode(mode: string): mode is FileMode {
  return mode === '100644' || mode === '100755';
}

/** the tree mode git gives a regular file with the permission bits `mode`
 *  (`stat.mode`): executable iff the owner-execute bit is set */
export function fileModeOf(mode: number): FileMode {
  return mode & 0o100 ? '100755' : PLAIN_FILE;
}

/** a note file: `index.md` or `index.mdx` */
export function isNoteFile(path: string): boolean {
  const base = posix.basename(path);
  return base === 'index.md' || base === 'index.mdx';
}

/** the note id a note file's path names (`chasing/attention/index.mdx` → `chasing/attention`) */
export function noteIdOfPath(path: string): string {
  return posix.dirname(path);
}

/**
 * The unit a note id belongs to: the first segment of the id with its
 * locale prefix stripped (`en/chasing/attention` → `chasing`); '' for an
 * id that is only a locale segment.
 */
export function unitOf(id: string, locales: readonly { prefix: string }[]): string {
  const prefix = localePrefixOf(id, locales);
  const bare = prefix && id.startsWith(prefix) ? id.slice(prefix.length) : prefix ? '' : id;
  return bare.split('/')[0] ?? '';
}

/** directory names at the content root that are never a unit — every name
 *  the content scanner and the check CLIs skip, so a copy could not land
 *  where no check would see it: the schema and registry directory, the
 *  site's documentation, the inbox importer's target, dependencies */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set(['_meta', 'docs', 'inbox', 'node_modules']);

/**
 * Why `unit` cannot name a unit of a wiki serving `prefixes`, or null when
 * it can: a unit is one id segment (no slash, no leading dot or dash) that
 * is not a reserved root name, not a locale's own segment (`en` would
 * cover every note of that locale), and spells a valid staging branch and
 * verdict path (`syndicate/<origin>/<unit>`, `<origin>/<unit>.json`).
 */
export function unitNameProblem(unit: string, prefixes: readonly string[]): string | null {
  if (!NOTE_ID.test(unit) || unit.includes('/')) return `'${unit}' is not a note id segment`;
  if (RESERVED_ROOT_NAMES.has(unit)) return `'${unit}' is a reserved directory, not a unit`;
  if (prefixes.some((p) => p !== '' && p.slice(0, -1) === unit)) return `'${unit}' is a locale directory, not a unit`;
  const ref = checkBranchName(`syndicate/origin/${unit}`) ?? checkBranchName(`verdicts/origin/${unit}.json`);
  if (ref) return `'${unit}' cannot name a git ref: it ${ref}`;
  return null;
}

/** why a path inside a unit's directories cannot be a unit file: a
 *  dot-prefixed segment (hidden files are never collected, so a copy
 *  holding one was not sent by an origin) */
export function unitPathProblem(path: string): string | null {
  return path.split('/').some((seg) => seg.startsWith('.')) ? `${path}: a dot-prefixed path segment` : null;
}

/** the unit's directories, one per locale prefix, the default locale's first */
export function unitRoots(unit: string, prefixes: readonly string[]): string[] {
  const ordered = ['', ...prefixes.filter((p) => p !== '')];
  return ordered.map((p) => `${p}${unit}`);
}

/** `path` lies under one of the unit's directories */
export function inUnitRoots(path: string, unit: string, prefixes: readonly string[]): boolean {
  return unitRoots(unit, prefixes).some((root) => path.startsWith(`${root}/`));
}

/** the directory is present without a symlink in any component below the
 *  content root (its real path is the root's real path plus the same
 *  segments); false when absent — any other failure propagates */
function unitRootDir(contentRoot: string, root: string): string | null {
  const dir = join(contentRoot, root);
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isDirectory()) return null;
  return realpathSync(dir) === join(realpathSync(contentRoot), root) ? dir : null;
}

/**
 * Collect the unit's files from a content root: regular files only, each
 * with the tree mode git would give it, walked with lstat — symlinks are
 * never followed, and a unit directory reached through a symlink in any
 * component (a linked locale directory included) is not the unit's;
 * dot-prefixed entries are skipped, and `_meta` / `docs` are ordinary
 * names inside a unit (they are reserved at the content root alone). A
 * directory that cannot be read fails the collection — a partial unit
 * would publish as a deletion of the rest. Throws when the default-locale
 * root note is missing: there is no unit then.
 */
export function collectUnit(contentRoot: string, unit: string, prefixes: readonly string[]): Bundle {
  const bundle: Bundle = new Map();
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      const path = `${rel}/${entry.name}`;
      const stat = lstatSync(abs);
      if (stat.isDirectory()) walk(abs, path);
      else if (stat.isFile()) bundle.set(path, { bytes: readFileSync(abs), mode: fileModeOf(stat.mode) });
    }
  };
  for (const root of unitRoots(unit, prefixes)) {
    const dir = unitRootDir(contentRoot, root);
    if (dir) walk(dir, root);
  }
  if (!bundle.has(`${unit}/index.md`) && !bundle.has(`${unit}/index.mdx`)) {
    throw new Error(`'${unit}' is not a unit: ${unit}/index.md or index.mdx does not exist`);
  }
  return bundle;
}

/** the `origin` block of a note's frontmatter mapping, when it is one:
 *  a copy's stamp with its wiki name, revision and receipt time */
export function copyOriginOf(data: Record<string, unknown>): CopyOrigin | null {
  const origin = data['origin'];
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const { wiki, revision, synced } = origin as Record<string, unknown>;
  if (typeof wiki !== 'string' || typeof revision !== 'string') return null;
  return { wiki, revision, synced: synced instanceof Date ? synced.toISOString() : String(synced ?? '') };
}

/* ---------------- digest ---------------- */

/**
 * A canonical text for a frontmatter value: JSON for strings, finite
 * numbers, booleans, null, arrays (in order) and plain objects (keys
 * sorted at every depth), and an explicit `<type:payload>` form — never
 * valid JSON, so it cannot collide with a plain value — for what YAML
 * produces beyond JSON: timestamps, sets, ordered maps, non-finite
 * numbers, binary. A cyclic value (an alias inside its own anchor) or
 * anything else throws.
 */
export function stableJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : `<number:${String(value)}>`;
  if (typeof value === 'bigint') return `<bigint:${value.toString()}>`;
  if (typeof value !== 'object') throw new Error(`a ${typeof value} value cannot be canonicalized`);
  if (seen.has(value)) throw new Error('the value is cyclic');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
    if (value instanceof Date) return `<date:${Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()}>`;
    if (value instanceof Set) return `<set:[${[...value].map((item) => stableJson(item, seen)).join(',')}]>`;
    if (value instanceof Map) return `<map:[${[...value].map(([k, v]) => `[${stableJson(k, seen)},${stableJson(v, seen)}]`).join(',')}]>`;
    if (value instanceof Uint8Array) return `<bytes:${Buffer.from(value).toString('base64')}>`;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('an object of an unsupported class cannot be canonicalized');
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v, seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** the git blob id of `bytes` (what `git hash-object` prints) */
export function blobId(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * A note file's digest part: SHA-256 of the frontmatter as sorted JSON
 * without `origin`, a newline, and the body as written. A note whose
 * block is absent, unreadable or cyclic hashes as written.
 */
export function notePart(text: string): string {
  const fm = splitFrontmatter(text);
  let canonical = text;
  if (fm.present && !fm.error) {
    const { origin: _origin, ...data } = fm.data;
    try {
      canonical = `${stableJson(data)}\n${text.slice(fm.end)}`;
    } catch {
      canonical = text;
    }
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The digest part of the tree entry at `path` with git mode `mode` and
 * blob id `sha`: a regular note file's content part is the note part of
 * its text (`text` is read for such an entry alone), any other entry's
 * is its blob id; a mode other than the plain file's prefixes the content
 * part — `100755:` for an executable file, a symlink's or a submodule's
 * mode for an entry that is no file at all, so such an entry never
 * digests like a file's bytes. The one rule both wikis compute the
 * revision with, from bytes here and from a tree listing there.
 */
export function entryPart(path: string, mode: string, sha: string, text: () => string): string {
  const content = isFileMode(mode) && isNoteFile(path) ? notePart(text()) : sha;
  return mode === PLAIN_FILE ? content : `${mode}:${content}`;
}

/** the digest of (path, part) pairs, in any order */
export function digestOfParts(parts: Iterable<[path: string, part: string]>): string {
  const hash = createHash('sha256');
  for (const [path, part] of [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${path}\0${part}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** the digest of a bundle */
export function digest(bundle: Bundle): string {
  return digestOfParts(
    [...bundle].map(([path, { bytes, mode }]) => [path, entryPart(path, mode, blobId(bytes), () => Buffer.from(bytes).toString('utf8'))]),
  );
}
