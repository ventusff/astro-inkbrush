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
  /** the wikis this one publishes to (inkbrush.config.ts → syndication.peers),
   *  listed whether or not the requester is signed in; absent when none is
   *  configured — the client then mounts no peer chip */
  syndication?: { peers: SyndicationPeerInfo[] };
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
  /** this locale's id prefix ('' for the default locale) — the locale table
   *  the client's [[ completion scopes candidates with */
  prefix: string;
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
  /** set when the note belongs to a copy synced from another wiki: the copy is
   *  read-only here (edits happen at its origin) */
  origin?: CopyOrigin | undefined;
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

/**
 * Who may read a share:
 *   password — whoever has the link and the password;
 *   link     — whoever has the link (the unguessable id is the key), kept
 *              out of search engines;
 *   public   — everyone, indexable, at a readable address when it has one.
 */
export type ShareVisibility = 'password' | 'link' | 'public';

/** one published snapshot of a note (`.wiki/data/shares.json`) */
export interface ShareRecord {
  /** 10-char base58 id — doubles as the gateway path /s/<id> */
  id: string;
  note: string;
  /** the site route the snapshot serves, e.g. "/notes/getting-started/" */
  route: string;
  /** public URL recipients open: <publicBase>/<alias>/ for a public share
   *  with an alias, <publicBase>/s/<id>/ otherwise */
  url: string;
  /** records written before visibility existed read as password shares */
  visibility: ShareVisibility;
  /** the readable address of a public share, or null */
  alias: string | null;
  /** creator's email — persisted and present in the create response;
   *  omitted from the list response */
  createdBy?: string;
  createdAt: string;
  /** ISO date, or null = never expires */
  expiresAt: string | null;
  /** set when revoked (record kept for audit; the list endpoint only returns
   *  shares that are neither revoked nor expired) */
  revokedAt: string | null;
  /** a pinned share keeps its published version: it never follows the note */
  pinned: boolean;
  /** ISO time of the version the gateway serves (creation, or the last
   *  publish) */
  publishedAt: string;
  /** fingerprint of the published snapshot — persisted, never returned */
  publishedHash?: string;
  /** the requesting user may revoke this share (its creator, or an admin
   *  while the identity registry is on) — computed per response, never
   *  persisted; absent on the stored record */
  canRevoke?: boolean;
  /** the note changed after the published version — computed per response */
  stale?: boolean;
  /** ISO time of that change (null when not stale) — computed per response */
  noteChangedAt?: string | null;
}

/** POST /api/wiki/share/<id>/pin request body */
export interface SharePinRequest {
  pinned: boolean;
}

/** POST /api/wiki/share request body — the snapshotted route derives from
 *  the note id via the site's URL rule on the server side */
export interface ShareCreateRequest {
  note: string;
  /** omitted = password (the request shape of older clients) */
  visibility?: ShareVisibility;
  /** required by a password share (6 characters minimum), refused by the others */
  password?: string;
  /** a public share's readable address (optional; omitted = the id address) */
  alias?: string;
  /** 7 · 30 · null/omitted = never */
  expiresDays?: 7 | 30 | null;
}

/** POST /api/wiki/share/<id>/visibility request body — the same rules as
 *  creation: a password with 'password', an optional alias with 'public' */
export interface ShareVisibilityRequest {
  visibility: ShareVisibility;
  password?: string;
  alias?: string;
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
  /** the deployment's follow window (0 = shares publish by hand only) */
  followIdleMinutes: number;
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

/* ---------------- syndication ---------------- */

/** the `origin` frontmatter block of a copy — stamped by the wiki the note
 *  came from before it commits the copy */
export interface CopyOrigin {
  /** the sending wiki's configured name (`syndication.name` there) */
  wiki: string;
  /** digest of the copy's content as sent (16 hex) */
  revision: string;
  /** ISO time the copy was sent */
  synced: string;
}

/** a peer as MeResponse lists it */
export interface SyndicationPeerInfo {
  id: string;
  title: string;
}

/**
 * Where a unit stands on one peer:
 *   absent   — no copy there, the id is free;
 *   occupied — the peer holds a note of its own at this id (publishing adopts it);
 *   foreign  — the peer holds a copy from another wiki at this id (cannot publish);
 *   current  — the copy is exactly what publishing now would send;
 *   behind   — the copy is intact but publishing now would send something else;
 *   changed  — the copy was edited on the peer after it was received.
 */
export type CopyState = 'absent' | 'occupied' | 'foreign' | 'current' | 'behind' | 'changed';

/** a wikilink or Markdown link that becomes plain text in the copy */
export interface DegradedLink {
  /** the note (id) the link is written in */
  note: string;
  /** what the link pointed at, as written */
  target: string;
  /** the text the copy shows instead */
  shown: string;
}

/** what publishing the unit now would send */
export interface SyndicationPlan {
  notes: number;
  files: number;
  bytes: number;
  /** the unit root's classification in the copy (kind, domains, tags, status —
   *  whichever the note carries after the peer's value map and overrides) */
  fields: Record<string, unknown>;
  /** the per-peer overrides the unit root carries (`syndication.<peer>`), or null */
  overrides: Record<string, unknown> | null;
  degraded: DegradedLink[];
  warnings: SyndicationWarning[];
}

/** why the unit's state on the peer forbids a submission — the peer's gate
 *  and this wiki apply the same rules */
export type SyndicationConflict = 'foreign' | 'native' | 'gone' | 'moved' | 'changed' | 'digest-mismatch';

/** why a publish or withdraw did not go through; the client localizes the
 *  code, `message` is the English fallback */
export type SyndicationErrorCode =
  | SyndicationConflict
  /** this wiki's own gates refused the copy (`problems` carries them) */
  | 'invalid'
  /** the unit cannot be published (see the status's refusals) */
  | 'refused'
  /** this server is already publishing or withdrawing the unit */
  | 'busy'
  /** a submission for the unit is still being checked by the peer */
  | 'pending'
  /** the peer's gate refused the submission (`problems` carries its findings) */
  | 'rejected'
  /** git could not reach the peer (`message` carries git's first line) */
  | 'unreachable';

/** a step of a publish or withdraw, for the progress line */
export type SyndicationStage = 'fetching' | 'preparing' | 'checking' | 'submitting' | 'waiting';

/** a root-relative link in a note body that the copy cannot keep working:
 *  an image, or a JSX attribute (href/src) — Markdown links degrade instead */
export interface SyndicationWarning {
  /** the note (id) it is written in */
  note: string;
  url: string;
  kind: 'image' | 'element';
}

/** why a unit cannot be published */
export type SyndicationRefusal =
  /** the note says `syndication: false` */
  | { code: 'never'; note: string }
  /** the note is itself a copy (it carries `origin`) */
  | { code: 'copy'; note: string }
  /** the note has no frontmatter block (a copy needs one for its origin stamp) */
  | { code: 'no-frontmatter'; note: string }
  /** its frontmatter does not parse; `detail` is the YAML parser's own message */
  | { code: 'frontmatter'; note: string; detail: string }
  /** the unit has no default-locale root note */
  | { code: 'no-root'; note: string }
  /** a link the peer cannot keep could not be turned into plain text
   *  without changing the note's structure around it */
  | { code: 'degrade'; note: string; target: string };

/** a submission the peer's gate has not accepted into its published branch:
 *  still being checked, or refused with the gate's findings */
export interface SyndicationSubmission {
  action: 'publish' | 'withdraw';
  state: 'pending' | 'rejected';
  /** the revision submitted (publish) */
  revision?: string | undefined;
  /** when it was submitted (pending) or refused (rejected), ISO */
  at: string;
  /** the peer's findings (rejected) */
  problems?: string[] | undefined;
  code?: SyndicationConflict | undefined;
  /** the staged commit this submission is (pending) or was (rejected) — the
   *  identity a client matches its own submission against */
  commit: string;
}

/** the state of one unit on one peer */
export interface SyndicationUnitStatus {
  /** `url` is the peer site's origin (scheme and host of its copy pages) */
  peer: { id: string; title: string; url: string };
  /** whether the peer's repository could be read for this answer */
  state: 'ready' | 'unreachable';
  /** why the peer is unreachable */
  error?: string | undefined;
  unit: string;
  /** null when the peer could not be read */
  copy: CopyState | null;
  /** publishing now would change the copy (true for 'behind'; for 'changed' when
   *  the received revision also differs from what would be sent) */
  behind: boolean;
  /** the copy's recorded revision and receipt time */
  revision?: string | undefined;
  synced?: string | undefined;
  /** absolute URL of the copy's page on the peer */
  copyUrl?: string | undefined;
  /** newest change under the unit's directories here (display only) */
  sourceChangedAt?: string | undefined;
  /** what publishing would send; absent when the unit cannot be published */
  plan?: SyndicationPlan | undefined;
  /** why the unit cannot be published */
  refusals?: SyndicationRefusal[] | undefined;
  /** a submission the peer has not accepted yet, or refused */
  submission?: SyndicationSubmission | undefined;
}

/** GET /api/wiki/syndication?note=<id> */
export interface SyndicationNoteResponse {
  /** the unit the note belongs to (its top-level id) */
  unit: string;
  /** set when the note is a copy synced into THIS wiki (then `peers` is empty) */
  isCopy: CopyOrigin | null;
  peers: SyndicationUnitStatus[];
}

/** one copy in GET /api/wiki/syndication/overview — or a first publication
 *  the peer has not accepted yet (`copy: 'absent'` with a `submission`) */
export interface SyndicationOverviewCopy {
  unit: string;
  /** the unit root's title here, or the unit id when the note is gone here */
  title: string;
  copy: CopyState;
  behind: boolean;
  revision?: string | undefined;
  synced?: string | undefined;
  copyUrl?: string | undefined;
  /** the unit no longer exists in this wiki (renamed or deleted) */
  missing: boolean;
  submission?: SyndicationSubmission | undefined;
}

/** GET /api/wiki/syndication/overview */
export interface SyndicationOverviewResponse {
  peers: Array<{
    peer: { id: string; title: string; url: string };
    state: 'ready' | 'unreachable';
    error?: string | undefined;
    copies: SyndicationOverviewCopy[];
  }>;
}

/** POST /api/wiki/syndication/<peer>/publish */
export interface SyndicationPublishRequest {
  note: string;
  /** replace a note the peer holds of its own at this id */
  adopt?: boolean;
  /** replace a copy that was edited on the peer */
  force?: boolean;
}

/** POST /api/wiki/syndication/<peer>/withdraw */
export interface SyndicationWithdrawRequest {
  note: string;
  /** withdraw a copy that was edited on the peer */
  force?: boolean;
}

/** POST /api/wiki/syndication/<peer>/overrides — null clears them */
export interface SyndicationOverridesRequest {
  note: string;
  fields: Record<string, unknown> | null;
}

/** POST /withdraw and /overrides answer with the unit's fresh status */
export interface SyndicationActionResponse {
  ok: true;
  status: SyndicationUnitStatus;
}

/** NDJSON stream of POST /api/wiki/syndication/<peer>/publish */
export type SyndicationStreamEvent =
  | {
      kind: 'progress';
      stage: SyndicationStage;
      /** seconds waited so far (stage 'waiting') */
      seconds?: number | undefined;
      message: string;
    }
  /** the submission reached the peer's repository: from here on its outcome
   *  is the peer's to decide, whatever happens to this stream */
  | { kind: 'submitted'; commit: string; revision: string }
  | { kind: 'result'; ok: true; status: SyndicationUnitStatus }
  | {
      kind: 'error';
      message: string;
      code?: SyndicationErrorCode | undefined;
      /** this wiki's gate findings or the peer's, one line each */
      problems?: string[] | undefined;
    };

/** an error body of the plain JSON syndication routes (withdraw, overrides) */
export interface SyndicationErrorResponse {
  error: string;
  code?: SyndicationErrorCode | undefined;
  problems?: string[] | undefined;
}
