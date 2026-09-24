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

A pipeline often carries plugins that only hold for a whole note — heading
numbering with its `§` cross-references, reading time. The preview renders
one block, so those stay out of `remarkPlugins` / `rehypePlugins`; name the
full page pipeline as `markdown.page: { remarkPlugins, rehypePlugins }` and
every whole-note gate (manual save, AI job, inbox import) compiles with it —
a cross-reference to a heading that carries no number is refused at save
time instead of breaking the page.

A site that also passes `guard` options or `remark-rehype` options to
`markdownProcessor` hands the same values here (`markdown.guard`,
`markdown.remarkRehype`) so the save gate runs them too. Its
content-collection schema goes in as `markdown.frontmatter` — an
`astro/zod` schema as it is, or any [Standard Schema](https://standardschema.dev)
— and the save gate then refuses the frontmatter the build would refuse
(a required field missing, a list over its limit), with the field named in
the editor. The same schema runs ahead of the build in a content repo's CI:
`check-content.mjs --frontmatter <module>` loads it from a module exporting
the schema or a factory `({ z }) => schema` called with Astro's zod, so the
module a content repo keeps beside its notes needs no dependencies.

The integration only runs under `astro dev`; in any other command it logs a
warning and does nothing. In WIKI mode it also turns off Astro's dev toolbar
(editors don't need island-audit instrumentation) while keeping the error
overlay — when content breaks, that overlay *is* the editor's error UI.

## Feature tour

### Block editing (✎)

Hover any block and click the ✎ handle: the rendered block collapses into a
CodeMirror editor over that block's MDX source, with a live server-rendered
preview (350 ms debounce; JSX component blocks skip the preview and say so),
`[[` autocompletion over the note's own language — its pages by id, title,
brand and alias, spelled as a link in that language is written; another
language opens once its prefix is typed (`[[de/`) — ⌘/Ctrl+Enter to save,
Esc to cancel. Two gates protect every save:

- **Optimistic lock** — the block's content hash travels with the edit; if
  someone else changed it meanwhile the save is refused (409) and you're
  asked to refresh.
- **Whole-file MDX compile** — the server compiles the complete note with
  the edit applied; a syntax error refuses the save (422) rather than
  writing a broken file.

On success, Astro's content HMR reloads the page and your scroll position is
restored.

The **frontmatter** edits the same way: rehype-wiki-blocks anchors it to the
element your layout marks `[data-inkbrush-slot="frontmatter"]` — the page
head, the meta strip, whatever renders title, description, tags from it —
so hovering that element offers the ✎ handle over the YAML block. The slot
is required (no slot, no frontmatter block: a heading guessed from the page
could be a body block already). YAML gets no preview (the page head
re-renders from it on save); the save gate requires it to parse. The ✦ is
not offered there.

A block is a top-level unit of the note's Markdown — a paragraph, heading,
list, table, code fence, display formula, callout, component. Two cases
edit where they render rather than where they are written: a **footnote
definition** is a block of its own, reached by hovering its entry in the
footnote list (its preview shows the definition's text under its
`[^label]`), and a **raw HTML block** of a `.md` note edits behind the
element it produces (in MDX it is a component block). Component blocks edit
as source, without preview. Content CI verifies the block map of every note
(`check-content`: stamps well-formed, disjoint, covering every block).

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
vault-relative path and of the file name — either match skips the file;
`['daily/']` skips a folder, `['scratch-']` skips files by name.

### Sharing

Publish a single note as a **password-gated static snapshot** on a gateway
you host — see [Sharing & the gateway contract](#sharing--the-gateway-contract).

### Syndication

Publish a note to another inkbrush wiki and keep it there as a read-only
copy that points back home — through the peer's git repository and its own
CI, never through a connection between the two servers. See
[Syndication: publishing to another wiki](#syndication-publishing-to-another-wiki).

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
  // share: { gatewayUrl: 'http://gateway.internal:8787', publicBase: 'https://share.example.com', prewarm: true, followIdleMinutes: 20 },
  // syndication: { name: 'vortex-wiki', peers: [{ id: 'chaser', title: 'Chaser Wiki', repo: 'git@github.com:acme/wiki.git', url: 'https://wiki.acme.com/wiki/{id}/' }] },
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
| `share.prewarm` | `false` | Keep the snapshot build warm in the background — [sharing](#sharing--the-gateway-contract) |
| `share.followIdleMinutes` | `20` | A share republishes once its note has been quiet this long; `0` = publish by hand only — [sharing](#sharing--the-gateway-contract) |
| `server.trustProxy` | `false` | Honor `x-forwarded-host`/`-proto` when deriving the server's own origin — set it exactly when a reverse proxy fronts the editor |
| `syndication.name` | — | How this wiki names itself on its peers (`origin.wiki` of its copies, the `syndicate/<name>/` branch namespace); required once peers exist — [syndication](#syndication-publishing-to-another-wiki) |
| `syndication.peers` | `[]` | The wikis this one publishes to: `{ id, title, repo, branch?, contentDir?, url, locales?, map? }` — [syndication](#syndication-publishing-to-another-wiki) |

The configuration is validated at startup: a malformed cookie name or
domain, a `trustedOrigins` entry that is not a bare origin, a non-http(s)
provider or gateway URL, an absolute `content.dir`, `autopush` without
`autocommit`, or a syndication peer without a `{id}` page URL, a
well-formed unique id or a wiki name to publish under refuses to start,
naming the field.

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
| `WIKI_TRUST_PROXY` | `server.trustProxy` (`0`/`1`) |
| `WIKI_CLAUDE_BIN` / `WIKI_CLAUDE_MODEL` | `claude.bin` / `claude.model` |
| `WIKI_SHARE_GATEWAY_URL` / `WIKI_SHARE_PUBLIC_BASE` | `share.gatewayUrl` / `share.publicBase` |
| `WIKI_SHARE_PREWARM` | `share.prewarm` (`0`/`1`) |
| `WIKI_SHARE_FOLLOW_IDLE_MINUTES` | `share.followIdleMinutes` |

`content.dir`, `content.locales` and `syndication` have no env override —
they are config-file decisions (and syndication has no secret at all: git
runs with the server's own environment). Enabling a provider is also always a config-file
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
any Google account. The login state is signed, bound to the starting
browser, single-use, and expires after 10 minutes — a replayed or stale
callback fails server-side. Entries can be domains (`acme.com`) or full addresses
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
static snapshot. First, **who can read**:

| visibility | who reads | search engines |
|---|---|---|
| password | whoever has the link **and** the password | noindex |
| link | whoever has the link — the unguessable id is the key | noindex |
| public | everyone; may live at a readable address `<publicBase>/<alias>/`, defaulting to the note id | indexed, canonical, in the sitemap |

1. **Create** — with a password, the popover pre-generates a 10-character
   one (editable; 6 characters minimum); public, it offers the address
   (1–64 lowercase letters, digits and inner hyphens; empty = the id
   address). Expiry is 7 days / 30 days / never (7 days by default for a
   password share, never for the other two). The server
   runs a **WIKI-free, production-mode `astro build`** (`NODE_ENV=production`
   whatever the dev server's own environment says) with the site's own
   installed astro binary, an allowlisted environment and a 10-minute cap.
   The build is cached in `.wiki/share-dist` and reused while no build input
   (`src/`, `public/`, `packages/`, `vendor/`, the astro config, the package
   manifest and lockfiles) has changed; a cold build takes as long as the
   site's own build, so progress streams live. With `share.prewarm: true`
   the cached build is kept fresh in the background — the inputs are probed
   every 15 s and the site rebuilt once it has been quiet for 30 s after a
   change — so a share request finds it ready and spends only the seconds
   of packing and uploading. The server then extracts the route's
   `index.html` plus its complete asset closure (HTML attributes → CSS
   `url()`/`@import` → the JS import graph), rewrites references to be
   `./`-relative, injects `noindex` unless the share is public, and PUTs a
   tar.gz to the gateway. Share ids are 10-character base58 — no `0/O/I/l`,
   readable aloud.
2. **Password** — only a password share has one. It travels once from the
   author's browser to the editing machine, is scrypt-hashed there, and only
   the hash reaches the gateway; the plaintext never persists anywhere. It
   is shown exactly once, at creation. One note has at most one active
   share: creating over a live one is refused (409) with the existing link.
3. **Change who can read** — an active share moves to another visibility,
   password or address: the popover's **Change who can read** fold posts
   `POST /share/<id>/visibility`. `/s/<id>/` is the permanent handle and
   always works; a changed readable address retires the old one at once,
   and `/s/<id>/` redirects to the new. Moving to a password mints a fresh
   one, shown once, and voids earlier unlock cookies. Only **becoming
   public** touches content: the snapshot is republished as indexable while
   the gateway still keeps the share private, and the gateway's record is
   changed last — a failure leaves an indexable page nothing indexes; a
   pinned share is not made public (that would publish the note as it is
   now) — unpin first. Every other move (leaving public, password ↔ link,
   a new address) changes the gateway's record only, no content travels.
   When the gateway's answer is uncertain, the record takes its word.
4. **Follow** — a share follows its note. Once the note has been quiet for
   `share.followIdleMinutes` (default 20) after a change — an editing
   session has ended; a single block save is not a version — the snapshot
   is rebuilt and, when its bytes differ from the published version, PUT to
   the same id without a password header: the link, the password and the
   expiry stay, the recipient reads the new version. **Publish this
   version** in the popover does the same at once; **Pin this version**
   freezes the share at what it serves now (unpin to follow again). The
   popover states which version the link serves and whether the note has
   changed since; the share chip carries the same as a dot (current ·
   unpublished changes · pinned). `followIdleMinutes: 0` turns automatic
   publishing off — shares then publish by hand only.
5. **Revoke** — deletes the gateway directory; the link 404s immediately.
   The local record (with `revokedAt`) is kept in `.wiki/data/shares.json`
   for audit.

The recipient opens the link and reads — after the password for a password
share; a public share lives at `<publicBase>/<alias>/` (`/s/<id>/` redirects
there; the id stays the permanent handle).

### The gateway admin API (implement your own)

The gateway is a contract, not a bundled service — any static host that
implements this small Bearer-authenticated admin API works (an afternoon's
work with nginx + a tiny app in front of a directory tree):

| Call | Meaning |
|---|---|
| `GET /admin/s` | Health/auth pre-flight; the engine calls it (5 s timeout) before an expensive build. 401 ⇒ bad token |
| `PUT /admin/s/<id>` | With `x-share-visibility` (or just `x-share-password`): create/replace snapshot `<id>`. Body: tar.gz with `index.html` at the archive root — extract into the directory you serve at `/s/<id>/`. With neither header: update the content of an existing share in place — swap the directory atomically, keep visibility, password, alias and creation time (expiry and note too unless the header is sent); answer 404 for an unknown id |
| `PATCH /admin/s/<id>` | JSON `{ visibility?, passwordHash?, alias?, expiresAt? }` — change what the share is without touching its content; `null` clears alias / expiry. Moving to password needs `passwordHash`; leaving password drops the hash; leaving public drops the alias; a taken alias is a 409 |
| `DELETE /admin/s/<id>` | Remove snapshot `<id>` (a 404 here is treated as already-gone); frees the alias |

Request headers on PUT:

| Header | Content |
|---|---|
| `authorization` | `Bearer <SHARE_GATEWAY_TOKEN>` |
| `x-share-visibility` | `password` / `link` / `public`, sent at creation. Absent with `x-share-password` present = `password` |
| `x-share-password` | `scrypt$N$r$p$<salt-b64url>$<hash-b64url>` — N=2¹⁵, r=8, p=1, 32-byte hash. Verify a visitor's password by re-computing with the embedded parameters. Required by a password share, refused by the other two; absent on a content update |
| `x-share-alias` | A public share's readable address (1–64 lowercase letters, digits and inner hyphens); serve it at `/<alias>/` and redirect `/s/<id>/` there |
| `x-share-expires` | Optional ISO-8601 timestamp; serve 404/410 after it |
| `x-share-note` | The source note id (URI-encoded when not printable ASCII) — informational |

The gateway's public side then serves by visibility: a password share's
`GET /s/<id>/…` sits behind a password prompt checked against the stored
hash; a link share is served as it is with `X-Robots-Tag: noindex`; a
public share carries no robots header, a canonical link, and a place in
`/sitemap.xml` (which `/robots.txt` points at). The gateway never sees a
plaintext password and holds no accounts.

## Syndication: publishing to another wiki

A note written in one inkbrush wiki can be **published to another** — a
*peer* — and kept there as a **copy** the peer serves as its own page. The
note stays owned by its *origin*: the copy is read-only on the peer, it
records where it came from, and from the origin's note page you see whether
the copy exists, whether it is current, whether someone touched it on the
peer, whether the peer is still checking it or refused it — and can publish
the current version or withdraw the copy in one click. The IndieWeb name
for this is syndication: the original is canonical, copies point back.

### What travels: the unit

A note is published together with everything that belongs to it — the
**unit**: the top-level note's directory (hub sub-pages, demo modules,
attachments) plus the same directory under every locale prefix
(`chasing/`, `en/chasing/`, `de/chasing/`). A unit is named by its
top-level id and exists iff `<unit>/index.{md,mdx}` exists. A copy lives at
exactly the id its original has — no renaming, so links between copies,
attachment URLs and `demo="<id>/…"` props stay valid unchanged. If the peer
already holds a note of its own at that id, publishing there **adopts** it
(replaces it) only when you say so explicitly.

### The two frontmatter fields (declare them in your schema)

```yaml
# on an original — optional
syndication: false            # this note is never published anywhere
# or
syndication:
  chaser:                     # a peer id from syndication.peers
    domains: [infra, llm]     # in the copy on that peer, these fields take these values
    kind: essay               # (null removes the field from the copy)

# on a copy — stamped by the origin before it commits the copy, always the last key
origin:
  wiki: vortex-wiki           # the origin's syndication.name
  revision: 3f9c2a1b7d4e5f60  # digest of the copy's content
  synced: 2026-09-23T10:21:07Z
```

`syndication: false` on any note of the unit refuses the whole unit; the
field never reaches a copy. A note carrying `origin` is a copy: the engine
refuses every local edit of its unit (block save, revert, AI edit,
translation — 423 with `code: 'copy'`), and an origin never publishes a
copy onward. Both fields are engine-defined; add them to the content repo's
schema (`_meta/schema.ts` in the zod-factory shape):

```ts
syndication: z.union([z.literal(false), z.record(z.string(), z.record(z.string(), z.unknown()))]).optional(),
origin: z.object({ wiki: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{16}$/), synced: z.coerce.date() }).optional(),
```

### What the copy is: the transform

The copy differs from the original in exactly three ways, all decided at
the origin from what it knows of both wikis:

- **Frontmatter.** The peer's `map` rewrites classification values
  (`map: { domains: { ai: 'llm', internal: null } }` → `[ai, internal, x]`
  becomes `[llm, x]`; lists fold duplicates); then the note's own
  `syndication.<peer>` overrides replace whole fields; then `syndication`
  is removed. Each change is a surgical edit of that one key — every other
  byte of the frontmatter stays as written.
- **Wikilinks.** A link the peer will resolve to the same note stays as
  written; one the peer would resolve elsewhere (a title the peer also
  uses, a locale mirror it lacks) is rewritten to the explicit id; one
  pointing at a note the peer will not have — outside this unit and not one
  of this wiki's copies there — becomes its visible text, escaped, and is
  listed in the plan.
- **Root-relative links.** A Markdown link to such a note becomes its text;
  an image or a JSX `href`/`src` is left alone and listed as a warning.

Everything else — bodies, modules, attachments — passes byte-identical.
The transform is deterministic, so the **revision** — sixteen hex characters
of a digest over the unit's files (notes by their frontmatter as sorted
JSON without `origin` plus their body; other files by git blob id) — is
the same whoever computes it: a reformatted frontmatter or a stamped
`origin` never changes it, a changed body or attachment always does.

### The transport: the peer's git repository

The two wikis' servers never talk to each other. A copy reaches the peer
only through the peer's content repository, and lands on its published
branch only through the peer's own CI:

```
origin                                       peer's repository (GitHub)               peer's CI
──────                                       ──────────────────────────               ─────────
.wiki/data/syndication/<peer>.git  ◀─fetch─  refs/heads/main            (the published tip)
  (bare, partial: blobs > 1 MiB               refs/heads/syndicate/<name>/<unit>  ◀─── syndication-gate prepare
   stay on the remote)                        refs/heads/syndication-verdicts     ◀─── syndication-gate finish
publish ──commit on the tip──push──▶          refs/heads/syndicate/<name>/<unit>  ───▶ its own checks on the promoted commit
                                                                                        ├─ ok:   push to main, delete the branch, remove <name>/<unit>.json
                                                                                        └─ fail: <name>/<unit>.json on syndication-verdicts, delete the branch
```

1. **Publish** (`POST /syndication/<peer>/publish`): fetch the mirror,
   decide from the peer's tip what is expected there (nothing; a copy at
   its recorded revision; a native note, only with `adopt`; a changed copy,
   only with `force`); transform the unit; run *this wiki's* body gates on
   every note (the page pipeline, the guard, MDX compilation — never the
   peer's schema, which is the peer's business); stamp `origin`; build one
   commit on the peer's tip whose tree is the tip with the unit's
   directories replaced (a temporary index in the bare mirror, so nothing
   is checked out anywhere); push it with `--force` to
   `syndicate/<name>/<unit>`; then wait for the gate — up to eight
   minutes, polling every ten seconds — and answer with the copy's status.
   The commit's author is the signed-in user (`Name <email>` — the
   attribution the peer's history carries, by design), its committer the
   server's git identity, and its message names the submission in
   trailers the gate verifies:

   ```
   wiki: chasing synced from vortex-wiki (3f9c2a1b7d4e5f60)

   Syndication-Origin: vortex-wiki
   Syndication-Unit: chasing
   Syndication-Action: publish            | withdraw
   Syndication-Expect: none | adopt | <revision the origin saw>
   Syndication-Revision: 3f9c2a1b7d4e5f60  (publish only)
   Syndication-Force: yes                  (only when forced)
   ```

2. **Withdraw** (`POST /syndication/<peer>/withdraw`): the tip without the
   unit's directories, pushed the same way; answers at once with the
   pending submission (the client polls).

3. **The gate** runs in the peer's CI on every push to `syndicate/**`
   (see the workflow below), bound to the one commit the push delivered
   (`--staged`). `prepare` re-derives everything from git: the branch
   names an origin the repository accepts (`--origins`); the branch and
   the trailers agree; the unit is a note unit of the peer (one id
   segment; not `_meta`, `docs`, `inbox`, `node_modules`, a locale
   segment or a dot name — the names the peer's discovery and checks
   skip — and not a path that is a file on `main`); the commit changes
   only the unit's directories, with regular files only (no symlink, no
   submodule, no dot-prefixed path, no note directory holding both
   index.md and index.mdx); every note carries `origin` with the
   submitted revision and the files digest to it; the unit's state on the
   *current* tip of `main` still allows the submission (the same rules
   the origin applied, so a race with a concurrent change on the peer is
   refused as `moved` or `changed`, never merged blind); then it builds
   the **promoted commit** — the current tip with the unit's directories
   replaced by the staged ones, same author and message — verifies that
   it differs from the tip only under those directories, and checks it
   out detached, so the peer's normal checks run on exactly the commit
   that would land. Anything about the submission the gate cannot read is
   a refusal too, never a stranded branch. `finish --ok` pushes that commit, as checked, to
   `main`; a tip that moved meanwhile is refused with exit code 3 and the
   workflow runs `prepare` and the checks again (up to three rounds) —
   nothing unchecked is ever pushed. Then the staging branch is deleted
   only if it still points at the checked commit (a newer submission
   stays), and the unit's verdict file, if any, is removed. `finish
   --fail` records the checks' output (up to 200 lines) about the checked
   commit as `<name>/<unit>.json` on the peer's **`syndication-verdicts`**
   branch — a commit on that branch's tip (a tip that moved means
   rebuilding the one-file change), a branch the peer's rulesets keep
   senders out of — and deletes the staging branch under the same lease.

4. **States**, all derived from the mirror's refs — nothing is stored at
   the origin that git does not already say: `absent` (the id is free),
   `occupied` (the peer's own note; publishing adopts it), `foreign` (a copy
   from another wiki; never touched), `current` (the copy's digest equals
   its recorded revision equals what publishing now would send), `behind`
   (intact, but the unit changed here), `changed` (edited on the peer after
   receipt — its digest differs from its recorded revision; publishing
   needs `force`). Alongside: a **submission**, named by its staged
   commit — `pending` while the staging branch exists (whatever its commit
   says), `rejected` while a verdict is still the answer: a refused
   publish while what publishing now would send is the revision it
   refused (a changed note or override makes it moot), a refused
   withdrawal while the copy exists — with the gate's findings verbatim.

### The peer side: `scripts/syndication-gate.mjs`

Run by the peer's CI inside a checkout of its content repository's own
published branch — never of the pushed branch: the submitted commit is
read as git objects (fetched by sha when the checkout lacks them), and
the only content that reaches the working tree is the promoted commit
the gate builds. Both subcommands print usage with `--help`:

```
node <engine>/scripts/syndication-gate.mjs prepare --branch "$GITHUB_REF_NAME" --staged "$GITHUB_SHA" --origins <a,b> \
    [--base main] [--remote origin] [--content-dir ''] [--locales en/,de/]
    → stdout: the promoted commit's sha; the workspace is checked out at it; exit 0
    → exit 2: the submission breaks the contract — the verdict is written and pushed
      (an origin outside --origins is refused with exit 2 and nothing recorded)
    → any other non-zero exit: the gate itself failed
node <engine>/scripts/syndication-gate.mjs finish --branch … --staged … --promoted <sha> --origins <a,b> --ok
    → exit 3: main moved since prepare — run prepare and the checks again
node <engine>/scripts/syndication-gate.mjs finish --branch … --staged … --promoted <sha> --origins <a,b> --fail --problems <file>
```

`--staged` is the commit the push delivered (`$GITHUB_SHA`): the whole
run judges that commit and no other, whatever the branch points at
later. `--origins` lists the wikis whose copies the repository accepts;
it has no default, and without it the gate does not run. It
authenticates nothing by itself: a deploy key cannot be scoped to one
origin's branches, so every credential the repository accepts can push
any accepted origin's staging branch — accepting two origins means those
two wikis trust each other with their copies here. `--content-dir`
is the notes root inside the repository (default the repository root),
`--locales` the locale prefixes the peer serves beside its default
(default the engine's table, `en/,de/`) — a submission touching a locale
directory the peer does not serve is refused. A reference workflow:

```yaml
name: Syndication gate
on:
  push:
    branches: ['syndicate/**']
concurrency:
  group: syndication-gate-${{ github.ref }}
  cancel-in-progress: false
jobs:
  gate:
    if: ${{ !github.event.deleted }}
    runs-on: ubuntu-latest
    steps:
      # the checkout is this repository's own main — the pushed commit is the
      # sender's and never enters the working tree; the gate reads it as git
      # objects and checks out only the promoted commit it built
      - uses: actions/checkout@v4
        with: { ref: main, fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - name: gate
        env:
          GATE: engine/scripts/syndication-gate.mjs   # the engine checkout of your choice
          ORIGINS: vortex-wiki                         # the wikis this repository accepts copies from
          BOT_SSH_KEY_B64: ${{ secrets.BOT_SSH_KEY_B64 }}
        run: |
          set -euo pipefail
          git remote set-url origin "git@github.com:${GITHUB_REPOSITORY}.git"
          # the promotion key exists only while the gate itself runs: written for
          # prepare and finish, removed before the checks, and the checks run
          # without the secret in their environment
          key="$RUNNER_TEMP/bot-key"
          hide_key() { rm -f "$key"; }
          restore_key() { (umask 077; printf '%s' "$BOT_SSH_KEY_B64" | base64 -d > "$key"); }
          gate() { GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes" node "$GATE" "$@"; }
          for round in 1 2 3; do
            restore_key
            set +e
            promoted=$(gate prepare --branch "$GITHUB_REF_NAME" --staged "$GITHUB_SHA" --origins "$ORIGINS")
            code=$?
            set -e
            if [ "$code" = 2 ]; then echo "refused — the verdict is recorded"; exit 0; fi
            test "$code" = 0
            hide_key
            # the checks' report is their stdout (the problems file); stderr stays in this log
            set +e
            env -u BOT_SSH_KEY_B64 ./your-content-checks.sh > "$RUNNER_TEMP/checks.log"
            checks=$?
            set -e
            cat "$RUNNER_TEMP/checks.log"
            restore_key
            if [ "$checks" != 0 ]; then
              gate finish --branch "$GITHUB_REF_NAME" --staged "$GITHUB_SHA" --promoted "$promoted" --origins "$ORIGINS" --fail --problems "$RUNNER_TEMP/checks.log"
              exit 1
            fi
            set +e
            gate finish --branch "$GITHUB_REF_NAME" --staged "$GITHUB_SHA" --promoted "$promoted" --origins "$ORIGINS" --ok
            code=$?
            set -e
            if [ "$code" = 3 ]; then continue; fi   # main moved: prepare and check again
            exit "$code"
          done
          # the rounds ran out: the submission is refused so it never strands (the origin can resubmit)
          echo "main kept moving for three rounds — resubmit" > "$RUNNER_TEMP/checks.log"
          restore_key
          gate finish --branch "$GITHUB_REF_NAME" --staged "$GITHUB_SHA" --promoted "$promoted" --origins "$ORIGINS" --fail --problems "$RUNNER_TEMP/checks.log"
          exit 1
```

The peer needs no inkbrush configuration for this: its repository, its CI
and its schema (which must declare `origin`) are the whole peer side.
The checks run on the promoted commit, which contains the sender's
files: they must not execute submitted content (compile and validate it,
never import a submitted module or run a submitted script), or they must
run in a separate job that holds no secret. The promotion credential is
present only while the gate itself runs — never in the checks' files or
environment, as above.
Its checks must cover every submitted note — the gate accepts a unit at
any name its discovery and checks would see; the names they skip
(`_meta`, `docs`, `inbox`, `node_modules`, locale segments, dot names)
are reserved so nothing can land where no check looks. `check-content`
writes its report to stdout, which is what the workflow captures as the
problems file; the plugins' own chatter on stderr stays in the CI log.

### Hard requirement: rulesets on the receiving repository

A push-triggered workflow runs the definition inside the pushed commit,
and the peer's checks import the peer's own schema and modules. So the
sender's credential — the deploy key or app the origin pushes with — must
be unable to touch anything but its staging branches, or accepting
syndication means accepting code execution with the peer's promotion
identity. **Do not accept syndication without both rulesets**
(Repository settings → Rules → Rulesets):

- **Push ruleset** (target: all pushes) with **Restrict file paths**:
  `.github/**/*` and `_meta/**/*` (add whatever else the peer's checks
  execute — `package.json`, scripts). Bypass list: the team the peer's
  own people and its promotion identity belong to; never the sender.
- **Branch ruleset** targeting **all branches except `syndicate/**`**
  (include *All branches*, exclude `refs/heads/syndicate/**/*`) with
  **Restrict creations**, **Restrict updates** and **Restrict deletions**.
  Same bypass list. The sender can then create, update and delete only
  `syndicate/**`, and `main` moves only through the gate.
- **Tag ruleset** (all tags) with the same three restrictions and the same
  bypass list.

Write every pattern with a trailing `/**/*`: GitHub matches these patterns
with path semantics, where a bare `**` at the end matches one level only —
`refs/heads/syndicate/**` misses `syndicate/<origin>/<unit>`, and
`.github/**` misses `.github/workflows/gate.yml`.

**Grant the bypass to a team (or to named users), never to a repository
role or to organization admins.** GitHub evaluates a deploy key with write
access as holding the repository's roles: a bypass for *Maintain* or
*Admin* — or for *Organization admin* — lets the sender's deploy key
through every rule above, and the push reports "Bypassed rule violations"
instead of being declined. Verify the setup with the sender's own
credential before accepting anything: pushing to `main`, creating any
branch outside `syndicate/**`, pushing a tag, and pushing a
`syndicate/**` commit that touches `.github/**` must each be declined with
`GH013: Repository rule violations`.

With those in place the sender's credential can at most stage
submissions, which the gate judges before anything runs or lands, and
the verdicts on `syndication-verdicts` — a branch outside `syndicate/**`
— are the gate's alone. The rulesets tell senders from the peer's own
people, not senders from each other: with several accepted origins, each
can stage under any accepted name (see `--origins` above).

### Security model

- **No shared credentials.** The origin pushes with its own git
  environment (the same ssh configuration or credential helper autopush
  uses) — write access to the peer's `syndicate/**` branches is all it
  needs, and the rulesets above are all it gets. The peer's CI promotes
  with the peer's own identity. No token of one wiki ever reaches the
  other's server, and the engine reads none: `syndication` has no env
  variables.
- **No foreign code runs.** The origin reads the peer's notes (frontmatter
  as YAML) from its mirror and never imports the peer's schema or modules;
  the peer runs the engine's gate and its own checks on the promoted
  commit before anything is published.
- **Attribution.** The staging and promoted commits carry the signed-in
  user as author (name and email), the sender's `syndication.name` in the
  message, and every note of a copy carries `origin`. The `syndication` field
  (per-peer overrides) never leaves the origin.
- **Nothing lands blind.** The gate re-decides on the current tip with the
  same rules the origin applied, so a copy edited on the peer or moved to
  another revision between the origin's look and the gate's run is refused
  rather than overwritten, and the origin sees why; what it pushes to
  `main` is exactly the commit the checks ran on, and a submission
  replaced during the run is neither judged by its findings nor deleted.

## Wikilinks

`[[target]]`, `[[target|label]]`, `[[target#anchor]]` — available in notes
and the editor preview, with `[[` autocompletion in the editor (scoped to
the note's language; a typed locale prefix opens another). Comments
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
| `GET /inbox/status` | signed-in | `{enabled, watching, seen, imported}` |
| `POST /inbox/import` | signed-in | `{path}` backfill; path confined to `inbox.dir` |
| `GET /comments/<id>` | public | Live comments (deletions applied); authors appear as `{name, provider}` — emails never leave the server; `canDelete` is computed per requester |
| `POST /comments/<id>` | signed-in | New comment (413 over 10,000 chars) |
| `DELETE /comments/<id>?cid=` | signed-in | Own comments only (403 otherwise) |
| `GET /identity/users` | admin | Members + role vocabulary |
| `PUT /identity/users` | admin | Full-list overwrite (validated; last admin protected) |
| `POST /share` | signed-in | Create share — `{note, visibility?, password?, alias?, expiresDays?}` (no visibility = password); NDJSON `progress…` → `result`; 409 when the note already has an active share |
| `POST /share/<id>/visibility` | signed-in | Change who can read — `{visibility, password?, alias?}`, the rules of creation; NDJSON `progress…` → `result`; creator or admin (403 otherwise); 409 while a publish is running |
| `GET /share?note=<id>` | signed-in | Active shares for a note (the note parameter is required); each record carries `canRevoke` for the requester, `stale`/`noteChangedAt` against the published version, and the response the deployment's `followIdleMinutes` |
| `POST /share/<id>/publish` | signed-in | Republish the share from the note as it is now — NDJSON `progress…` → `result`; creator or admin (403 otherwise); 409 while a publish is running |
| `POST /share/<id>/pin` | signed-in | `{pinned}` — a pinned share never follows its note; creator or admin |
| `DELETE /share/<id>` | signed-in | Revoke — the share's creator, or an admin when the registry is on (403 otherwise) |
| `GET /syndication?note=<id>` | signed-in | `{unit, isCopy, peers[]}` — the note's unit, its `origin` when the note is a copy here (then `peers` is empty), and per peer the unit's status: `copy` state, `behind`, `revision`/`synced`/`copyUrl`, the `plan` (what publishing would send: counts, classification preview, degraded links, warnings) or `refusals`, and a pending/rejected `submission`; a peer whose repository cannot be fetched answers `state: 'unreachable'` |
| `GET /syndication/overview` | signed-in | Per peer: every unit of this wiki's the peer holds or is deciding on, with `missing` when the unit no longer exists here |
| `POST /syndication/<peer>/publish` | signed-in | `{note, adopt?, force?}` → NDJSON `progress` (`stage`: fetching · preparing · checking · submitting · waiting, `seconds` while waiting) → `submitted` `{commit, revision}` once the staging push succeeded → `result` `{status}` or `error` `{code, problems?}`; a status's `submission` names its staged `commit`; codes: the conflicts (`foreign`/`native`/`gone`/`moved`/`changed`/`digest-mismatch`), `invalid` (this wiki's gates), `refused`, `busy`, `pending`, `rejected` (the gate's findings in `problems`), `unreachable` |
| `POST /syndication/<peer>/withdraw` | signed-in | `{note, force?}` → `{ok, status}` at once, the withdrawal pending on the peer; errors `{error, code, problems?}` (409 conflicts, 502 unreachable) |
| `POST /syndication/<peer>/overrides` | signed-in | `{note, fields \| null}` → sets or clears `syndication.<peer>` on the unit's root note (validated, journaled, autocommitted) → `{ok, status}` |

AI jobs are capped at 2 in flight per user and 4 machine-wide (429
beyond); queued jobs hold no capacity. Each job kind carries a
postcondition: a block edit may change nothing in the note outside the
selected block (companions stay free), and a translation may change
nothing but its target file — a result violating its postcondition is
refused whole.

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
                (block ↔ source-line stamping), wikilinks, frontmatter-edit
                (surgical top-level key edits), syndication-bundle / -transform /
                -state / -git (the unit, its digest, the copy, the submission
                rules and the git plumbing both sides of syndication run)
src/wiki/shared/  cross-boundary types + locales.ts (the locale registry +
                  resolveLocales)
scripts/        check-content.mjs / check-wikilinks.mjs / check-dist.mjs — standalone check CLIs;
                syndication-gate.mjs — the receiving wiki's gate, run by its CI
```

Editing = writing to `<content.dir>` source files; Astro's content HMR
refreshes the page. **Files are the database, git is the history** — the
journal adds per-block audit granularity on top. All CMS state lives under
`.wiki/` at the site root (git-ignored):

The `.wiki/` tree is created 0700 and its files 0600 — journal, comments
and identity records carry emails and roles.

```
.wiki/
  secret                    session HMAC secret (generated on first run, 0600)
  data/comments/<id>.ndjson append-only comments (note ids URL-encoded)
  data/revisions.ndjson     the edit journal
  data/inbox-sync.json      inbox watcher state (content hashes)
  data/shares.json          share records (incl. revoked, for audit)
  data/syndication/<peer>.git  bare partial mirror of a peer's content repository
  share-dist/               cached WIKI-free build for snapshots
  tmp/                      scratch directories (a copy being packed), removed when done
```

Trust model, stated plainly: **membership is code trust.** Notes are
Markdown/MDX — a member can author components, expressions and raw HTML
that the site build and the editor preview execute, on the same origin as
the CMS. That is the nature of an MDX wiki: adding someone to the
registry means trusting them the way you trust a committer, admins
included. The CMS's authorization tiers (member/admin, share creator)
gate its API, not what authored content can do once rendered. Keep the
registry short and human.

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
capped; syndication moves content only through the peer's git repository
and its CI, with each side's own credentials and no foreign code executed.

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
