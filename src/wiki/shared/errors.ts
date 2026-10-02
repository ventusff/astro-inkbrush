/**
 * errors — every failure the wiki API reports, as a code and its parameters.
 *
 * An error answer is `{ error, code, params }` (an NDJSON stream's error
 * event carries the same three as `message`, `code`, `params`). The page
 * words `code` with `params` in its own language (client/strings.ts);
 * `error` is the English line, for the server log and for callers that are
 * not a page. A `detail` parameter is a line produced by a tool — a
 * compiler, git, the claude CLI, the share gateway, a thrown error — and is
 * shown as it is in every language.
 *
 * Publish and withdraw outcomes of syndication keep their own code set
 * (SyndicationErrorCode in ./types.ts); a syndication route's request-level
 * failures (no such peer, no such note) use this one.
 *
 * Keep this file dependency-free (both bundles import it).
 */

/** what a share action was, in `share-not-yours` */
export type ShareAction = 'publish' | 'change' | 'pin' | 'revoke';

/** the parameters each code carries */
export interface WikiErrorParams {
  /* —— the request —— */
  /** a request no page sends (a missing field, a malformed body) */
  'bad-request': { detail: string };
  'body-too-large': { limit: number };
  'cross-site': {};
  'sign-in-required': {};
  'admin-only': {};
  'not-member': {};
  /** a failure no code names; `detail` is its own line */
  unexpected: { detail: string };
  /** an unhandled server error; `id` finds it in the server log */
  internal: { id: string };

  /* —— sign-in —— */
  'dev-login-off': {};
  'dev-login-fields': {};
  'google-off': {};
  'google-unconfigured': {};
  'google-base-url': {};
  'saml-off': {};
  'saml-unconfigured': {};

  /* —— members (identity registry) —— */
  'members-email': { email: string };
  'members-duplicate': { email: string };
  'members-role': { role: string; roles: string[] };
  'members-admin': { role: string };

  /* —— notes, blocks and revisions —— */
  'note-not-found': {};
  'note-ambiguous': { id: string };
  /** the note is a copy synced from another wiki: edits happen there */
  copy: { wiki: string };
  'line-range': {};
  'block-changed': {};
  'save-would-not-build': { detail: string };
  'revision-not-found': {};
  'revert-whole-file': {};
  'revert-no-change': {};
  'revert-overwritten': {};
  'revert-ambiguous': {};

  /* —— comments —— */
  'comment-empty': {};
  'comment-too-long': { max: number };
  'comment-not-found': {};
  'comment-not-yours': {};

  /* —— AI jobs —— */
  'ai-busy-user': { max: number };
  'ai-busy-machine': { max: number };
  'chat-session': {};
  'job-setup': { detail: string };
  'job-range-gone': {};
  'translate-same': {};
  'translate-unsupported': { lang: string };
  'translate-exists': { id: string };
  'translate-target': { id: string };
  'claude-unavailable': { detail: string };
  'job-timeout': { seconds: number };
  'client-disconnected': {};
  'job-error': { detail: string };
  'job-deleted-note': { file: string };
  'job-no-baseline': { file: string };
  'job-outside-block': { file: string; start: number; end: number };
  'job-touched-source': { file: string };
  'job-stray-file': { file: string };
  'job-no-target': { file: string };
  'job-would-not-build': { detail: string };
  'job-conflict': { file: string };

  /* —— shares —— */
  'share-off': {};
  'share-unconfigured': {};
  'share-exists': {};
  'share-creating': {};
  'share-busy': {};
  'share-not-found': {};
  'share-not-yours': { action: ShareAction };
  'share-password-short': {};
  'share-password-unexpected': { visibility: string };
  'share-alias-not-public': {};
  'share-alias-invalid': {};
  'share-unpin-first': {};
  'share-revoked-meanwhile': {};
  'gateway-token': {};
  'gateway-status': { status: number; detail: string };
  'gateway-unreachable': { url: string; detail: string };
  'gateway-refused': { detail: string };
  'gateway-lost': {};
  /** the gateway answered 404 to a change: the share is gone, or the
   *  gateway predates visibilities */
  'gateway-unknown-share': {};
  'gateway-outdated': {};
  'snapshot-unstable': {};
  'snapshot-too-large': { size: number; limit: number };

  /* —— syndication routes —— */
  'syndication-off': {};
  'peer-unknown': { peer: string };
  'unit-unknown': { unit: string };
  'overrides-no-frontmatter': {};
  'overrides-never': {};

  /* —— Obsidian inbox —— */
  'inbox-off': {};
  'inbox-missing': { path: string };

  /* —— the browser-local playground —— */
  /** the browser keeps no local storage for this page */
  'storage-unavailable': {};
  /** the feature needs the dev server */
  'playground-unavailable': {};
}

export type WikiErrorCode = keyof WikiErrorParams;

/** one failure: a code with its parameters */
export type WikiFailure = { [K in WikiErrorCode]: { code: K; params: WikiErrorParams[K] } }[WikiErrorCode];

/** the parameter argument of a code — optional when the code carries none */
export type ParamsArg<K extends WikiErrorCode> = {} extends WikiErrorParams[K]
  ? [params?: WikiErrorParams[K]]
  : [params: WikiErrorParams[K]];

/** a wording of every code — one per language */
export type ErrorTable = { [K in WikiErrorCode]: (params: WikiErrorParams[K]) => string };

export function failure<K extends WikiErrorCode>(code: K, ...[params]: ParamsArg<K>): WikiFailure {
  return { code, params: params ?? {} } as WikiFailure;
}

/** a failure worded by a table */
export function wordFailure(table: ErrorTable, f: WikiFailure): string {
  return (table[f.code] as (params: WikiErrorParams[WikiErrorCode]) => string)(f.params);
}

/** the codes this build knows — a body from another engine version may carry others */
export function isWikiFailure(value: { code?: unknown; params?: unknown }): boolean {
  return (
    typeof value.code === 'string' &&
    Object.hasOwn(ENGLISH_ERRORS, value.code) &&
    typeof value.params === 'object' &&
    value.params !== null
  );
}

const SHARE_ACTION_VERB: Record<ShareAction, string> = {
  publish: 'publish',
  change: 'change',
  pin: 'pin',
  revoke: 'revoke',
};

/** the English wording — the `error` line of every answer, and the page's
 *  wording on an English page */
export const ENGLISH_ERRORS: ErrorTable = {
  'bad-request': ({ detail }) => detail,
  'body-too-large': ({ limit }) => `Request body too large (max ${limit} bytes)`,
  'cross-site': () => 'Cross-site request refused',
  'sign-in-required': () => 'Sign in required',
  'admin-only': () => 'Admin only',
  'not-member': () => 'Not a member of this site',
  unexpected: ({ detail }) => detail,
  internal: ({ id }) => `Internal error (${id})`,

  'dev-login-off': () =>
    'Dev login is disabled (inkbrush.config.ts → auth.dev; without an explicit dev: true it serves loopback clients only)',
  'dev-login-fields': () => 'A name and a valid email are required',
  'google-off': () => 'Google login is not enabled (inkbrush.config.ts → auth.google)',
  'google-unconfigured': () =>
    'Google login is enabled but GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is missing from the environment',
  'google-base-url': () => 'Google login needs auth.google.baseUrl (inkbrush.config.ts) outside localhost',
  'saml-off': () => 'SAML login is not enabled (inkbrush.config.ts → auth.googleSaml)',
  'saml-unconfigured': () =>
    'SAML login is enabled but not fully configured (entryPoint / idpEntityId / certFile / baseUrl)',

  'members-email': ({ email }) => `Invalid email: '${email}'`,
  'members-duplicate': ({ email }) => `Duplicate email: ${email}`,
  'members-role': ({ role, roles }) => `Unknown role '${role}' (allowed: ${roles.join(', ')})`,
  'members-admin': ({ role }) => `At least one '${role}' must remain`,

  'note-not-found': () => 'Note not found',
  'note-ambiguous': ({ id }) => `Note '${id}' has both index.md and index.mdx — remove one of them`,
  copy: ({ wiki }) => `This note is a copy synced from ${wiki} — edit it there`,
  'line-range': () => 'The line range lies outside the file',
  'block-changed': () => 'This block was modified by someone else — refresh and retry',
  'save-would-not-build': ({ detail }) => `The note would not build — not saved: ${detail}`,
  'revision-not-found': () => 'Revision record not found',
  'revert-whole-file': () => 'Whole-file operations cannot be reverted in one click',
  'revert-no-change': () => 'This revision has no content change',
  'revert-overwritten': () => 'Later edits overwrote this revision — revert by hand instead',
  'revert-ambiguous': () => 'The target content appears more than once — revert by hand instead',

  'comment-empty': () => 'Comment cannot be empty',
  'comment-too-long': ({ max }) => `Comment too long (more than ${max} characters)`,
  'comment-not-found': () => 'Comment not found',
  'comment-not-yours': () => 'You can only delete your own comments',

  'ai-busy-user': ({ max }) => `You already have ${max} AI jobs running — wait for one to finish`,
  'ai-busy-machine': ({ max }) => `The machine is already running ${max} AI jobs — try again when one finishes`,
  'chat-session': () =>
    'Unknown chat session for this user and note (sessions reset when the server restarts) — start a new conversation',
  'job-setup': ({ detail }) => `Could not prepare the job: ${detail}`,
  'job-range-gone': () =>
    'The selected line range no longer exists (the note changed while the job was queued) — reload and retry',
  'translate-same': () => 'Target language equals the current language',
  'translate-unsupported': ({ lang }) => `Unsupported target language: ${lang}`,
  'translate-exists': ({ id }) => `That language version already exists: ${id}`,
  'translate-target': ({ id }) => `Invalid target id: ${id}`,
  'claude-unavailable': ({ detail }) => `Could not start the claude CLI: ${detail} (set WIKI_CLAUDE_BIN to point at it)`,
  'job-timeout': ({ seconds }) => `Job timed out (${seconds} s) and was terminated`,
  'client-disconnected': () => 'Client disconnected',
  'job-error': ({ detail }) => `The AI job failed: ${detail}`,
  'job-deleted-note': ({ file }) => `The job deleted the note's own file (${file})`,
  'job-no-baseline': ({ file }) => `The note file (${file}) has no baseline to edit a block of`,
  'job-outside-block': ({ file, start, end }) =>
    `The job changed lines outside the selected block (L${start}-${end}) of ${file}`,
  'job-touched-source': ({ file }) => `The job modified the source note (${file})`,
  'job-stray-file': ({ file }) => `The job changed a file besides the target (${file})`,
  'job-no-target': ({ file }) => `The job did not produce the target file (${file})`,
  'job-would-not-build': ({ detail }) => `The result would not build: ${detail}`,
  'job-conflict': ({ file }) => `'${file}' was modified while the job ran`,

  'share-off': () => 'Share is not configured (inkbrush.config.ts → share)',
  'share-unconfigured': () => 'Share is enabled but gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN is missing',
  'share-exists': () => 'This note already has an active share link — revoke it first',
  'share-creating': () => 'A share for this note is already being created — wait for it to finish',
  'share-busy': () => 'This share is being published right now — wait for it to finish',
  'share-not-found': () => 'Share not found',
  'share-not-yours': ({ action }) => `Only the share creator (or an admin) can ${SHARE_ACTION_VERB[action]} it`,
  'share-password-short': () => 'Password must be at least 6 characters',
  'share-password-unexpected': ({ visibility }) => `A ${visibility} share carries no password`,
  'share-alias-not-public': () => 'Only a public share can have an address',
  'share-alias-invalid': () => 'Address: lowercase letters, digits and inner hyphens, up to 64 characters',
  'share-unpin-first': () => 'Unpin the share first — making it public would publish the note as it is now',
  'share-revoked-meanwhile': () => 'The share was revoked while it was being changed',
  'gateway-token': () => 'Share gateway rejected SHARE_GATEWAY_TOKEN',
  'gateway-status': ({ status, detail }) => `Share gateway error (HTTP ${status})${detail ? `: ${detail}` : ''}`,
  'gateway-unreachable': ({ url, detail }) => `Share gateway unreachable (${url}): ${detail}`,
  'gateway-refused': ({ detail }) => `The share gateway refused: ${detail}`,
  'gateway-lost': () => 'The share gateway no longer holds this share — revoke it and share the note again',
  'gateway-unknown-share': () =>
    'The share gateway no longer holds this share, or does not know share visibilities yet',
  'gateway-outdated': () =>
    'The share gateway does not know link or public shares yet — update the gateway, or share with a password',
  'snapshot-unstable': () => 'The site keeps changing while the snapshot builds — retry when edits pause',
  'snapshot-too-large': ({ size, limit }) => `The snapshot bundle is ${size} MiB, above the ${limit} MiB limit`,

  'syndication-off': () => 'Syndication is not configured (inkbrush.config.ts → syndication)',
  'peer-unknown': ({ peer }) => `No such syndication peer: ${peer}`,
  'unit-unknown': ({ unit }) => `'${unit}' is not a unit here`,
  'overrides-no-frontmatter': () => 'The note has no readable frontmatter block',
  'overrides-never': () => 'The note says syndication: false — remove that first',

  'inbox-off': () => 'Inbox is not enabled (inkbrush.config.ts → inbox.dir)',
  'inbox-missing': ({ path }) => `File does not exist: ${path}`,

  'storage-unavailable': () => 'Browser storage is unavailable — the edit cannot be kept',
  'playground-unavailable': () => 'Not available in the playground',
};

/** the English line of a failure */
export function englishOf(f: WikiFailure): string {
  return wordFailure(ENGLISH_ERRORS, f);
}
