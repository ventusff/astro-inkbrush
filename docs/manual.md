# Inkbrush manual

**English** | [简体中文](manual.zh-CN.md)

The deployment and usage reference for [astro-inkbrush](../README.md) — what
every feature does, every configuration key, the sign-in providers, the share
gateway contract, and the production deployment shape. For positioning and
the three-touch site integration, start with the [README](../README.md).

- [Quick start](#quick-start)
- [Feature tour](#feature-tour)
- [UI language](#ui-language)
- [Configuration](#configuration-inkbrushconfigts)
- [Sign-in providers & sessions](#sign-in-providers--sessions)
- [Identity registry & members](#identity-registry--members)
- [Sharing & the gateway contract](#sharing--the-gateway-contract)
- [Wikilinks](#wikilinks)
- [API reference](#api-reference-apiwiki)
- [Architecture & state on disk](#architecture--state-on-disk)
- [Production deployment](#production-deployment)

## Quick start

```bash
WIKI=1 astro dev      # editing mode — the CMS is active
astro build           # reading mode — output is byte-identical to a site
                      # that never installed the package
```

Open any note page and sign in from the account chip (top right, or wherever
your site placed the `[data-inkbrush-slot="account"]` slot). With no config
file present, the instant **dev login** (any name + email, no password) is
the only provider — fine for a local machine, never for anything reachable
from outside.

Which features are on (sign-in providers, the Obsidian inbox, autocommit…)
is decided per machine by `inkbrush.config.ts` at the site root — see
[Configuration](#configuration-inkbrushconfigts).

What the CMS knows about your Markdown pipeline comes from the integration
call itself. `inkbrush()` alone renders with the dialect; pass your own
plugins and your note-id → URL rule so the editor preview, the save-time
validation and the AI gate render a note exactly the way your pages do:

```ts
integrations: [inkbrush({
  markdown: { remarkPlugins, rehypePlugins, urlFor: (id) => `/notes/${id}/` },
})],
```

The integration only runs under `astro dev`; in any other command it logs a
warning and does nothing. In WIKI mode it also turns off Astro's dev toolbar
(editors don't need island-audit instrumentation) while keeping the error
overlay — when content breaks, that overlay *is* the editor's error UI.

## Feature tour

### Block editing (✎)

Hover any block and click the ✎ handle: the rendered block collapses into a
CodeMirror editor over that block's MDX source, with a live server-rendered
preview (350 ms debounce; JSX component blocks skip the preview and say so),
`[[` autocompletion over your note titles and aliases, ⌘/Ctrl+Enter to save,
Esc to cancel. Two gates protect every save:

- **Optimistic lock** — the block's content hash travels with the edit; if
  someone else changed it meanwhile the save is refused (409) and you're
  asked to refresh.
- **Whole-file MDX compile** — the server compiles the complete note with
  the edit applied; a syntax error refuses the save (422) rather than
  writing a broken file.

On success, Astro's content HMR reloads the page and your scroll position is
restored.

### AI assist (✦)

Requires a local [`claude` CLI](https://claude.com/claude-code) on the
machine running the dev server (configurable via `claude.bin` /
`claude.model`). Three surfaces, all streaming progress live over NDJSON:

- **Edit a block** — hover ✦, pick a quick intent (polish / more rigorous /
  condense / fix formulas) or write your own instruction; Claude edits the
  block in a working copy of the note, and the result is validated and
  journaled like any manual save. The job survives a closed tab.
  Timeout: 300 s.
- **Ask about the note** — the floating chat panel; Claude reads the note's
  source in a working copy and answers with math-rendered output.
  Follow-ups resume the same conversation; the transcript survives page
  reloads. Timeout: 300 s.
- **Translate the note** — one button per missing locale (from your
  [locale table](#contentlocales)). Not literal translation: the prompt
  casts Claude as the author rewriting the piece in the target language,
  with hard invariants (anchors, math structure, code logic, component
  props preserved; human-facing text translated — including text inside
  formulas). Refuses (409) if the target already exists. Timeout: 30 min.

Every job runs in a **throwaway workspace**: a temporary directory holding
a copy of the note's directory plus whatever `claude.companions` names for
that note (the demo module it mounts, say). The CLI's working directory is
that copy, its file tools are confined to it by permission rules (`Read`,
`Edit`, `Write`, `MultiEdit` on `./**` for edit jobs; `Read` only for ask
jobs), and `Bash`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `NotebookEdit`
and sub-agents are denied outright, and its environment is an allowlist —
deployment secrets never reach the child. When the job ends, the copy is
diffed against a snapshot taken at its start; every changed Markdown file
must pass the same build gate as a manual save (the dialect, the guard,
your plugins, MDX), and a file that changed in the project while the job
ran refuses the whole application — a manual edit always wins. Only then
are the changes (companions included) written, journaled and — with
`autocommit` — committed. Your site's own conventions reach every prompt through
`claude.rules`.

### Revision history & revert (⟲)

Every content change — manual, Claude, translation, inbox import, revert —
appends a record with a unique id to the journal (who, when, which lines,
before/after, via what). The ⟲ handle lists the current block's records
(matched by line overlap or exact content) with collapsible diffs and
one-click revert; a revert whose recorded text no longer stands at the
recorded block (later edits covered it, or the same text now appears in
more than one ambiguous place) is refused (409) instead of guessed.
Whole-file records — imports, translations, AI companion changes — are
listed as read-only audit rows: undoing them is a git operation.

### Comments

A comment section at the end of each note page (mounted into
`[data-inkbrush-slot="comments"]`, or a `.note-main .col` container as the
fallback). Markdown + `$…$` math + code blocks; rendered server-side through
a sanitizer (GitHub schema plus math classes; comments render math but
not wikilinks); 10,000
character cap; you can delete only your own comments. Stored as flat NDJSON
files next to the rest of the CMS state — no database.

### Obsidian inbox

Point `inbox.dir` at a vault folder and every **new** note dropped there is
converted and imported to `<content.dir>/inbox/<YYYY-MM-DD>-<hash>/` (date
from a `YYYY-MM-DD` parent folder, else the note's `saved` frontmatter, else
today). Files that already exist when the watcher starts are only marked as
seen — backfill those explicitly with `POST /api/wiki/inbox/import
{path}`. A changed source file re-imports to the same slug. Conversion
rules:

- `![[image|alt]]` embeds resolve against the note's `_assets/<note name>/`
  folder (then `_assets/`, then the note's own folder) and the files are
  **copied next to the imported note** — deleting the note directory deletes
  everything it owns. Unresolved embeds become a visible
  `*[missing attachment: …]*` marker.
- `[[wikilinks]]` that resolve to a real site note stay links; the rest
  flatten to italics.
- `==highlight==` → `<mark>`, single-line `$$x$$` display math is normalized
  to the three-line form.
- Obsidian clipper frontmatter (`author` / `source` / `url` / `saved`)
  becomes a `> Source: …` line; a description is derived from the first
  substantive paragraph.

`inbox.ignore` skips noise: each entry is matched as a prefix of the
vault-relative path *and* of the file name — `['daily/']` skips a folder,
`['scratch-']` skips files by name.

### Sharing

Publish a single note as a **password-gated static snapshot** on a gateway
you host — see [Sharing & the gateway contract](#sharing--the-gateway-contract).

### The account chip

Shows the signed-in user (and role, when the identity registry is on),
offers whichever sign-in providers are enabled, and hosts the admin Members
panel. Mounts into `[data-inkbrush-slot="account"]` when your chrome
provides it, else floats fixed top-right (`--wiki-chip-top` /
`--wiki-chip-right` to nudge it). The block handle's viewport clamping
respects `[data-inkbrush-sticky]` (falling back to a `.site-nav` element)
so the gutter never hides under your sticky header.

## UI language

The client UI ships in English and Chinese and picks per page from the
site's own `<html lang>`: a value starting with `zh` gets the Chinese UI,
anything else gets English. There is deliberately no config knob — the site
already declares its language. Dates follow the same choice. Server error
messages are English.

## Configuration (`inkbrush.config.ts`)

One file per deployment machine, at the site root, git-ignored (template:
`inkbrush.config.example.ts`; types: `astro-inkbrush/config`). **Having no
config file is valid**: defaults are dev login only, everything else off.

```ts
import { defineInkbrushConfig } from 'astro-inkbrush/config';

export default defineInkbrushConfig({
  auth: {
    dev: true,                    // never true on an externally reachable deployment
    google: false,                // or { allowedDomains: ['acme.com'], baseUrl: 'https://…' }
    // googleSaml: { entryPoint, idpEntityId, certFile, allowedDomains?, baseUrl },
    // session: { format?, cookieName?, cookieDomain?, ttlDays?, trustedOrigins? },
  },
  // identity: { dir: '.wiki/identity', roles?, defaultRole?, adminRole?, autoRegister? },
  inbox: { dir: '~/vault/inbox', ignore: ['daily/'] },   // omit dir = watcher off
  autocommit: false,
  autopush: false,
  // claude: { bin: 'claude', model: '…', companions?: (note) => [...], rules?: [...] },
  // content: { dir: 'src/content/notes', locales: [...] },
  // share: { gatewayUrl: 'http://gateway.internal:8787', publicBase: 'https://share.example.com' },
});
```

| Key | Default | Effect |
|---|---|---|
| `auth.dev` | `true` (loopback only) | Instant name+email login. The default serves loopback clients only; an explicit `true` serves every client — never on anything externally reachable |
| `auth.google` | off | Google OAuth — [setup](#google-oauth) |
| `auth.googleSaml` | off | Google Workspace SAML SSO — [setup](#google-workspace-saml-sso) |
| `auth.session` | hmac defaults | Session cookie behaviour — [sessions](#sessions) |
| `identity` | off | File-based member registry — [identity](#identity-registry--members) |
| `inbox.dir` | off | Obsidian inbox watch folder (`~/` supported) |
| `inbox.ignore` | `[]` | Import skip list (path/basename prefixes) |
| `autocommit` | `false` | git commit in the content repo after every save (author = the signed-in user) |
| `autopush` | `false` | async git push after each autocommit — turn on for deployment machines |
| `claude.bin` / `claude.model` | `'claude'` / CLI default | Which CLI binary / `--model` the AI endpoints run |
| `claude.companions` | none | `(note) => string[]` — project-relative files or directories a job may read and change beside the note's directory |
| `claude.rules` | `[]` | The site's own writing constraints, appended to the dialect's in every prompt |
| `content.dir` | `'src/content/notes'` | Note content root, relative to the site root |
| `content.locales` | zh/en/de table | The note language table — [below](#contentlocales) |
| `share` | off | Snapshot sharing — [sharing](#sharing--the-gateway-contract) |

Edits to the config apply on the next request (the server hot-reloads) —
except the inbox watch directory, which is created at dev-server startup and
needs a restart.

Every optional provider follows one three-state pattern: **off** (omitted in
the config — routes 404, the button doesn't render at all), **ready**
(usable), **unconfigured** (enabled but its env/cert is missing — the button
renders greyed out and the route answers 503). Sockets stay wired; nothing
half-works silently.

### `content.locales`

The note language table drives locale detection, the language switcher and
the AI translation targets. Note ids carry their locale as a path prefix;
**exactly one entry must have `prefix: ''`** — that's the default locale,
whose notes live unprefixed at the content root. Codes and prefixes must
be unique, and a non-empty prefix is a single path segment (`en/`);
anything else refuses to start. The default table is:

```ts
locales: [
  { code: 'zh', prefix: '',    label: '中文',    promptName: '中文' },
  { code: 'en', prefix: 'en/', label: 'English', promptName: 'English', appendixTitle: 'Appendix' },
  { code: 'de', prefix: 'de/', label: 'Deutsch', promptName: 'Deutsch（德语）', appendixTitle: 'Anhang' },
]
```

`label` shows in the language switcher, `promptName` is how translation
prompts name the language, `appendixTitle` titles a translated note's
appendix section (default `'Appendix'`). Prefixes must be `''` or end with
`/`; duplicates and zero-or-many default locales fail loudly at startup —
a mistake here would otherwise mis-file notes silently.

### Environment overrides

Env vars override the config **per run** (the file stays the durable truth):

| Variable | Overrides |
|---|---|
| `WIKI` | `1` activates wiki mode (dev only; required; no config equivalent) |
| `WIKI_DEV_LOGIN` | `auth.dev` (`0`/`1`) |
| `WIKI_ALLOWED_DOMAIN` | `auth.google.allowedDomains` (comma-separated) |
| `WIKI_BASE_URL` | `auth.google.baseUrl` / `auth.googleSaml.baseUrl` |
| `WIKI_SAML_SSO_URL` | `auth.googleSaml.entryPoint` |
| `WIKI_SAML_IDP_ENTITY_ID` | `auth.googleSaml.idpEntityId` |
| `WIKI_SAML_CERT_FILE` | `auth.googleSaml.certFile` |
| `WIKI_SAML_ALLOWED_DOMAIN` | `auth.googleSaml.allowedDomains` (comma-separated) |
| `WIKI_SESSION_FORMAT` | `auth.session.format` (`hmac`/`jwt`) |
| `WIKI_COOKIE_NAME` | `auth.session.cookieName` |
| `WIKI_COOKIE_DOMAIN` | `auth.session.cookieDomain` |
| `WIKI_SESSION_TTL_DAYS` | `auth.session.ttlDays` |
| `WIKI_TRUSTED_ORIGINS` | `auth.session.trustedOrigins` (comma-separated) |
| `WIKI_IDENTITY_DIR` | `identity.dir` (setting it enables the module) |
| `WIKI_INBOX_DIR` | `inbox.dir` (empty string = watcher off for this run) |
| `WIKI_INBOX_IGNORE` | `inbox.ignore` (comma-separated) |
| `WIKI_AUTOCOMMIT` / `WIKI_AUTOPUSH` | `autocommit` / `autopush` (`0`/`1`) |
| `WIKI_CLAUDE_BIN` / `WIKI_CLAUDE_MODEL` | `claude.bin` / `claude.model` |
| `WIKI_SHARE_GATEWAY_URL` / `WIKI_SHARE_PUBLIC_BASE` | `share.gatewayUrl` / `share.publicBase` |

`content.dir` and `content.locales` have no env override — they are
config-file decisions. Enabling a provider is also always a config-file
decision; env vars only override fields of a provider the config enabled.

**Secrets are env-only and never enter the config file**:
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (OAuth), `AUTH_SECRET` (jwt
sessions — startup error when missing), `ADMIN_EMAILS` (identity seeding),
`SHARE_GATEWAY_TOKEN` (gateway admin token).

## Sign-in providers & sessions

### Dev login

Name + email, no password, instant session. The default (no config file,
or `auth.dev` unset) serves **loopback clients only** — a dev server
started with `--host` refuses dev logins from other machines. An explicit
`auth.dev: true` opens it to every reachable client: for trusted private
networks only, never for anything externally reachable.

### Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → create an OAuth 2.0 Client ID (Web application).
2. Authorized redirect URI:
   `<auth.google.baseUrl>/api/wiki/auth/google/callback`
   (local testing: `http://localhost:4321/api/wiki/auth/google/callback`).
3. Enable `auth.google` in the config and start with the secrets:
   ```bash
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… WIKI=1 astro dev
   ```

The id token is verified against Google's tokeninfo endpoint (audience +
verified email), then checked against `allowedDomains` — a **fail-closed**
allowlist: an empty list denies everyone; pass `['*']` to explicitly allow
any Google account. Entries can be domains (`acme.com`) or full addresses
(`bob@gmail.com`).

### Google Workspace SAML SSO

A second Workspace channel, suited to one IdP app shared by several sites
(pair with jwt sessions + a shared cookie domain):

1. Google Admin console → Apps → Web and mobile apps → add a **custom SAML
   app**. Note the **SSO URL** (`entryPoint`) and **Entity ID**
   (`idpEntityId`), download the certificate and point `certFile` at it —
   three shapes are accepted: full multi-line PEM, bare base64 body, or a
   whole `base64 -w0 cert.pem` blob. `~/` and site-root-relative paths work.
2. On the app's SP side enter: ACS URL =
   `<baseUrl>/api/wiki/auth/saml/callback`, Entity ID =
   `<baseUrl>/api/wiki/auth/saml/metadata` (Name ID = email). To
   double-check, open `GET /api/wiki/auth/saml/metadata` — the SP metadata
   XML renders even before the certificate is configured.
3. Enable `auth.googleSaml: { entryPoint, idpEntityId, certFile,
   allowedDomains?, baseUrl }`.

Login flow: `GET /auth/saml/login?return=…` redirects to Google → Google
POSTs the assertion to the ACS (signature verified, email checked against
the allowlist, new users auto-registered when the identity module is on) →
303 back to `return`. Relative return paths are always allowed; off-site
origins must be listed in `session.trustedOrigins`. **The ACS never
500s** — every failure degrades to `303 /?login_error=<code>` with
`saml_config`, `saml_disabled`, `saml_response`, `saml_invalid`,
`wrong_domain`, `not_member` or `saml_error`. `allowedDomains` is
fail-closed like OAuth's: an empty list admits no one, `['*']` is the
explicit allow-everyone.

### Sessions

Two formats; omitted config keeps hmac defaults (`wiki_session`, host-only
cookie, 30 days):

- **`hmac`** — cookie signed with a generated per-site secret
  (`.wiki/secret`, created on first run, mode 0600). Right for a single
  site.
- **`jwt`** — HS256 via the `AUTH_SECRET` env var (startup error if
  missing). With `cookieDomain: '.example.com'` this gives cross-subdomain
  SSO: sibling apps on the same domain can validate the same cookie. Default
  lifetime 7 days (`ttlDays` to change).

Roles are never baked into the token — the registry is re-read per request,
so role changes and removals take effect immediately. Return-URL handling
(`?return=` on login, OAuth `state`, SAML RelayState) is guarded against
open redirects: relative paths always pass, `//`, `/\` and control
characters never do, and off-site origins must be in `trustedOrigins`.

## Identity registry & members

`identity: { dir }` enables a file-based registry: `<dir>/users.json`,
plain JSON `[{ email, name, role }]`, shareable on disk with other apps on
the same machine. The role vocabulary, the default role for first-time SSO
sign-ins, and the admin role name are all configurable (`roles` /
`defaultRole` / `adminRole`). While the registry is on, **every signed-in
route requires current membership** — a session whose user was removed
from the list is refused (403) on its next request.

- When `users.json` doesn't exist yet, admins are seeded from the
  `ADMIN_EMAILS` env var (comma-separated); the server refuses to start the
  registry without at least one admin.
- `autoRegister` (default `true`) lets a first SSO login from an allowed
  domain join with `defaultRole`; `false` turns the registry into an
  allow-list that only admins extend — unknown users are sent back with
  `?login_error=not_member`.
- Admins manage members from the account popover's **Members** panel; the
  server validates the vocabulary and enforces that at least one admin
  always remains.
- Writes are atomic (tmp + rename); a corrupt file refuses to degrade into
  an empty registry.

## Sharing & the gateway contract

With `share` configured, a **Share** chip appears in the
`[data-inkbrush-slot="share"]` slot (the site must provide the slot — no
slot, no button) and any signed-in user can publish the current note as a
password-gated static snapshot:

1. **Create** — the popover pre-generates a 10-character password (editable;
   6 characters minimum) and offers 7 days / 30 days / no expiry. The server
   runs a **WIKI-free `astro build`** with the site's own installed astro
   binary, an allowlisted environment and a 10-minute cap (cached in
   `.wiki/share-dist`; cold
   builds take minutes, so progress streams live), extracts the route's
   `index.html` plus its complete asset closure (HTML attributes → CSS
   `url()`/`@import` → the JS import graph), rewrites references to be
   `./`-relative, injects `noindex`, and PUTs a tar.gz to the gateway. Share
   ids are 10-character base58 — no `0/O/I/l`, readable aloud.
2. **Password** — travels once from the author's browser to the editing
   machine, is scrypt-hashed there, and only the hash reaches the gateway;
   the plaintext never persists anywhere. It is shown exactly once, at
   creation. One note has at most one active share: creating over a live
   one is refused (409) with the existing link.
3. **Revoke** — deletes the gateway directory; the link 404s immediately.
   The local record (with `revokedAt`) is kept in `.wiki/data/shares.json`
   for audit.

The recipient opens `<publicBase>/s/<id>/`, enters the password, reads.

### The gateway admin API (implement your own)

The gateway is a contract, not a bundled service — any static host that
implements this small Bearer-authenticated admin API works (an afternoon's
work with nginx + a tiny app in front of a directory tree):

| Call | Meaning |
|---|---|
| `GET /admin/s` | Health/auth pre-flight; the engine calls it (5 s timeout) before an expensive build. 401 ⇒ bad token |
| `PUT /admin/s/<id>` | Create/replace snapshot `<id>`. Body: tar.gz with `index.html` at the archive root — extract into the directory you serve at `/s/<id>/` |
| `DELETE /admin/s/<id>` | Remove snapshot `<id>` (a 404 here is treated as already-gone) |

Request headers on PUT:

| Header | Content |
|---|---|
| `authorization` | `Bearer <SHARE_GATEWAY_TOKEN>` |
| `x-share-password` | `scrypt$N$r$p$<salt-b64url>$<hash-b64url>` — N=2¹⁵, r=8, p=1, 32-byte hash. Verify a visitor's password by re-computing with the embedded parameters |
| `x-share-expires` | Optional ISO-8601 timestamp; serve 404/410 after it |
| `x-share-note` | The source note id (URI-encoded when not printable ASCII) — informational |

The gateway's public side then gates `GET /s/<id>/…` behind a password
prompt checked against the stored hash. It never sees a plaintext password
and holds no accounts.

## Wikilinks

`[[target]]`, `[[target|label]]`, `[[target#anchor]]` — available in notes
and the editor preview, with `[[` autocompletion in the editor. Comments
render math but not wikilinks: a comment must not mint site-internal
links. A `\[[escaped]]` opener stays literal text everywhere. `![[embeds]]` and the citation idiom `[[1]](#ref)` are deliberately
not wikilinks. Resolution order:

1. **The source note's locale mirror** — `[[X]]` inside an `en/` note
   resolves to `en/X` when that mirror exists;
2. **Exact id** (including explicitly prefixed spellings like `[[en/X]]`);
3. **Alias / brand / title**, case-insensitive — several different notes
   matching = *ambiguous*.

Ids are matched case-sensitively, the alias/title fallback is not. A miss
never breaks the build: it renders a `span.wikilink-dead` with a tooltip
(`no such note` / `ambiguous target`) and the site's `onBroken` hook fires
for linting.

## API reference (`/api/wiki/*`)

Auth column: public · signed-in · admin (admin = identity module on and
the caller's registry role equals `adminRole`; module off ⇒ these routes
404).

| Method & path | Auth | Behaviour |
|---|---|---|
| `GET /me` | public | Session + provider availability + share state (+ `role` when identity is on) |
| `POST /auth/dev` | public | `{name,email}` → session cookie; 403 when dev login is off |
| `GET /auth/google` | public | 302 to Google consent (`?return=` carried via `state`) |
| `GET /auth/google/callback` | public | Code → token verification → cookie → 302 back |
| `GET /auth/saml/login` | public | 302 to the IdP (`?return=` as RelayState) |
| `POST /auth/saml/callback` | public | ACS; never 500s — failures 303 to `/?login_error=<code>` |
| `GET /auth/saml/metadata` | public | SP metadata XML (works before the cert is configured) |
| `POST /logout` | public | Clears the session cookie |
| `GET /meta/<id>` | public | Note metadata: file, title, `locales` (exists/current per language) |
| `GET /notes` | public | Lightweight note list (autocomplete + link resolution) |
| `GET /block/<id>?start&end` | signed-in | Block source `{source, hash, start, end}` (400/416) |
| `PUT /block/<id>` | signed-in | Save `{start,end,hash,source}` (409 lock conflict / 422 build error); with autocommit on, a failed commit answers `{ok:true, git:'failed'}` |
| `POST /render` | signed-in | `{markdown, sanitize?, note?}` → HTML (sanitizing by default; trusted path resolves wikilinks) |
| `GET /revisions/<id>` | signed-in | Journal records for the note (most recent 100) |
| `POST /revert/<id>` | signed-in | `{id}` → revert that block revision (404/400/409/422; whole-file records 400) |
| `POST /claude/block` | signed-in | NDJSON stream; 300 s cap; survives client disconnect |
| `POST /claude/ask` | signed-in | NDJSON stream; 300 s cap; killed on disconnect; resumable — only by the user and note the session was opened for (403 otherwise; the session registry is in-memory and resets with the server) |
| `POST /claude/translate` | signed-in | NDJSON stream; 30 min cap; 409 if the target locale exists |

AI jobs are capped at 2 in flight per user (429 beyond).
| `GET /inbox/status` | signed-in | `{enabled, watching, seen, imported}` |
| `POST /inbox/import` | signed-in | `{path}` backfill; path confined to `inbox.dir` |
| `GET /comments/<id>` | public | Live comments (deletions applied); authors appear as `{name, provider}` — emails never leave the server; `canDelete` is computed per requester |
| `POST /comments/<id>` | signed-in | New comment (413 over 10,000 chars) |
| `DELETE /comments/<id>?cid=` | signed-in | Own comments only (403 otherwise) |
| `GET /identity/users` | admin | Members + role vocabulary |
| `PUT /identity/users` | admin | Full-list overwrite (validated; last admin protected) |
| `POST /share` | signed-in | Create share — NDJSON `progress…` → `result`; 409 when the note already has an active share |
| `GET /share?note=<id>` | signed-in | Active shares for a note (the note parameter is required) |
| `DELETE /share/<id>` | signed-in | Revoke — the share's creator, or an admin when the registry is on (403 otherwise) |

Cross-cutting: JSON bodies must be sent as `application/json` and are capped
at 1 MiB (415/413 otherwise); a state-changing request whose `Origin` (or
`Referer`) names another site than this one or a `trustedOrigins` entry is
refused (403) — a browser's cross-site form post carries its Origin, so a
cookie cannot be replayed from a foreign page (a request with neither
header is a non-browser client and passes); the SAML ACS is exempt — its
authentication is the signed assertion; intentional 4xx errors return `{error}` JSON, and
unexpected failures a 500 with a reference id that the server log carries.

## Architecture & state on disk

```
astro.config.ts ──WIKI=1──▶ inkbrush() integration   (src/wiki/integration.ts)
   ├─ injectScript('page') → src/wiki/client/*   (handles/editor/AI/comments/share UI;
   │                                              strings.ts = the en/zh string table)
   ├─ dev middleware /api/wiki/* → src/wiki/server/*   (ssrLoadModule — server code
   │                                                    hot-reloads too)
   └─ initWiki(root, { markdown }) → the identity registry check, the site's
                                     Markdown hooks, the inbox watcher

src/lib/        pipeline-agnostic libraries: markdown-syntax (the dialect),
                markdown (processor drop-in), content-guard, rehype-wiki-blocks
                (block ↔ source-line stamping), wikilinks
src/wiki/shared/  cross-boundary types + locales.ts (the locale registry +
                  resolveLocales)
scripts/        check-content.mjs / check-wikilinks.mjs / check-dist.mjs — standalone check CLIs
```

Editing = writing to `<content.dir>` source files; Astro's content HMR
refreshes the page. **Files are the database, git is the history** — the
journal adds per-block audit granularity on top. All CMS state lives under
`.wiki/` at the site root (git-ignored):

```
.wiki/
  secret                    session HMAC secret (generated on first run, 0600)
  data/comments/<id>.ndjson append-only comments (note ids URL-encoded)
  data/revisions.ndjson     the edit journal
  data/inbox-sync.json      inbox watcher state (content hashes)
  data/shares.json          share records (incl. revoked, for audit)
  share-dist/               cached WIKI-free build for snapshots
```

Security posture: Claude jobs run in a throwaway workspace with file tools
confined to it and no shell or network tools, and their output passes the
build gate before it is written; comment HTML is sanitized server-side;
every note, asset and inbox path is resolved to its real location and must
stay inside `content.dir` / `inbox.dir`; writes are atomic and serialized
in-process; OAuth uses PKCE with a browser-bound single-use state, SAML
accepts only responses to requests this server issued; the domain
allowlists are fail-closed; return URLs are open-redirect-guarded; jwt mode
refuses to start without its secret; membership and roles are re-read per
request; a mutation from a foreign `Origin` is refused; request bodies are
capped.

## Production deployment

The settled shape is **read/edit separation**: "edit and it's live" needs a
resident compiler, and Astro's resident-compiler form is the dev server —
so the editing machine runs one, as a product, while readers never touch it:

- **Readers only ever see `astro build` output** (nginx, object storage,
  Pages…). Without WIKI the build is byte-identical to a pure-static
  baseline — no dev traces, no CMS traces.
- **The editing machine is the authorized writing surface**: a dedicated
  subdomain (not a path prefix under the reader site — dev-server virtual
  module URLs are root-relative and break under a prefix), TLS behind a
  reverse proxy, `auth.dev: false` with a real provider, the content
  checkout on a persistent volume, and `autocommit` + `autopush` shipping
  every save back to the content repo, where CI rebuilds the reader site.
- One dev-server process serves one editing team: writes to a note are
  serialized per file inside the process, a concurrent save of the same
  block is refused with 409 instead of overwritten, and there is no
  cross-process coordination — run one instance per content repository.

Typical setups:

| | `auth.dev` | provider | `inbox.dir` |
|---|---|---|---|
| Personal machine / private network | `true` | — | your vault |
| Team intranet wiki | `false` | Google OAuth or SAML | as needed |
| Public static site + private editing origin | `false` | as needed | as needed |

A two-service skeleton (static reader + editing machine: Dockerfiles,
compose examples, an entrypoint that clones or updates the checkout, installs
the machine's config and credentials and starts the server) ships in
[`deploy/`](../deploy/README.md).
