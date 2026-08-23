/**
 * Types shared between the wiki server middleware and the injected client.
 * Keep this file dependency-free (both bundles import it).
 */

/** authenticated identity (dev provider / Google OAuth / Google SAML SSO) */
export interface WikiUser {
  name: string;
  email: string;
  /** avatar URL (google) — dev sessions get a generated initial */
  picture?: string;
  provider: 'dev' | 'google' | 'google-saml';
}

/** provider availability as the client sees it (google & googleSaml alike):
 *  'off' = disabled in inkbrush.config.ts (button not rendered) · 'ready' =
 *  usable · 'unconfigured' = enabled but secrets/cert/urls missing (button
 *  greyed out with a hint) */
export type GoogleAuthState = 'off' | 'ready' | 'unconfigured';

/** identity registry entry — plain users.json format, shareable across sibling apps */
export interface IdentityUser {
  email: string;
  name: string;
  role: string;
}

/** GET /api/wiki/me */
export interface MeResponse {
  user: WikiUser | null;
  providers: {
    /** dev quick-login available to THIS request (the default configuration
     *  serves loopback clients only; an explicit auth.dev: true serves all) */
    dev: boolean;
    google: GoogleAuthState;
    googleSaml: GoogleAuthState;
  };
  /** when the identity module is on and the user is signed in: their role in
   *  users.json (null = not registered) */
  role?: string | null;
  /** when the identity module is on and the user is signed in:
   *  role === adminRole ? 'admin' : 'member' */
  siteRole?: 'admin' | 'member';
  /** share module availability — 'off' = not configured (button not mounted)
   *  · 'ready' = usable · 'unconfigured' = enabled but gatewayUrl /
   *  publicBase / SHARE_GATEWAY_TOKEN missing (button greyed out) */
  share: GoogleAuthState;
  /** AI (claude) availability. Absent = available (the dev-server deployment
   *  shape); 'off' hides the block toolbar's ✦ — a transport that cannot run
   *  claude jobs (the browser-local playground) says so here. */
  ai?: 'off' | 'ready';
}

/** GET /api/wiki/identity/users (admin) — PUT on the same route submits
 *  { users } as a full overwrite */
export interface IdentityUsersResponse {
  users: IdentityUser[];
  /** configured role vocabulary (for the role dropdown) */
  roles: string[];
  defaultRole: string;
  adminRole: string;
}

/** locale code from the deployment's locale table (default: 'zh' | 'en' | 'de') */
export type NoteLocale = string;

export interface NoteLocaleInfo {
  code: NoteLocale;
  /** note id in this locale, e.g. "en/getting-started" (the default locale
   *  has no prefix) */
  id: string;
  /** display label for language switch / translate buttons */
  label: string;
  /** whether this locale's note already exists on disk */
  exists: boolean;
  /** the locale of the note being viewed */
  current: boolean;
}

/** GET /api/wiki/note/:id/meta */
export interface NoteMeta {
  id: string;
  /** repo-relative source path, e.g. "src/content/notes/getting-started/index.mdx" */
  file: string;
  title: string;
  lang: NoteLocale;
  /** every supported locale of this note (existing → link, missing → translate) */
  locales: NoteLocaleInfo[];
}

/** GET /api/wiki/notes list entry ([[ autocomplete / wikilink resolution) */
export interface NoteListItem {
  id: string;
  title: string;
  brand?: string | undefined;
  aliases: string[];
}

/** GET /api/wiki/notes */
export interface NotesResponse {
  notes: NoteListItem[];
}

/** GET /api/wiki/note/:id/block */
export interface BlockSource {
  source: string;
  /** sha256 of source — optimistic-lock token for PUT */
  hash: string;
  start: number;
  end: number;
}

/** a comment as the API returns it — the author's email never leaves the
 *  server (the stored record keeps it as the ownership key) */
export interface WikiComment {
  id: string;
  author: Pick<WikiUser, 'name' | 'provider'>;
  /** the requesting user may delete this comment (they authored it) */
  canDelete: boolean;
  /** raw markdown as submitted */
  markdown: string;
  /** sanitized rendered HTML */
  html: string;
  ts: number;
}

/** one line of the fetch-stream NDJSON protocol for claude jobs */
export type ClaudeStreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; label: string }
  | { kind: 'result'; ok: boolean; summary: string; sessionId: string | null }
  | { kind: 'error'; message: string };

/** one published password-gated snapshot of a note (`.wiki/data/shares.json`) */
export interface ShareRecord {
  /** 10-char base58 id — doubles as the gateway path /s/<id> */
  id: string;
  note: string;
  /** the site route the snapshot serves, e.g. "/notes/getting-started/" */
  route: string;
  /** public URL recipients open (<publicBase>/s/<id>/) */
  url: string;
  /** creator's email — persisted and present in the create response;
   *  omitted from the list response */
  createdBy?: string;
  createdAt: string;
  /** ISO date, or null = never expires */
  expiresAt: string | null;
  /** set when revoked (record kept for audit; the list endpoint only returns
   *  shares that are neither revoked nor expired) */
  revokedAt: string | null;
  /** the requesting user may revoke this share (its creator, or an admin
   *  while the identity registry is on) — computed per response, never
   *  persisted; absent on the stored record */
  canRevoke?: boolean;
}

/** POST /api/wiki/share request body — the snapshotted route derives from
 *  the note id via the site's URL rule on the server side */
export interface ShareCreateRequest {
  note: string;
  password: string;
  /** 7 · 30 · null/omitted = never */
  expiresDays?: 7 | 30 | null;
}

/** NDJSON stream of POST /api/wiki/share (a cold snapshot build can take minutes) */
export type ShareStreamEvent =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; ok: true; share: ShareRecord }
  | { kind: 'error'; message: string };

/** GET /api/wiki/share?note=<id> — active (not revoked, not expired) shares
 *  of that note only; the note parameter is required (400 without), and the
 *  records omit createdBy and carry canRevoke for the requester */
export interface ShareListResponse {
  shares: ShareRecord[];
}

export interface RevisionRecord {
  /** unique id; the revert endpoint addresses a record by it */
  id: string;
  ts: number;
  user: string;
  note: string;
  /** project-relative file the record is about when it is not the note's
   *  own source (an AI job's companion-file change) */
  file?: string;
  /** "start-end" line range, or "*" for whole-file operations */
  lines: string;
  via: 'manual' | 'claude' | 'translate' | 'inbox' | 'revert';
  before: string;
  after: string;
}
