# AGENTS.md — working on astro-inkbrush

Guidance for coding agents (and humans) contributing to this repo.

## What this is

astro-inkbrush is a **minimal CMS layer** for Astro delivered as one
integration: in-place block editing, block-level revision history and
revert, an AI bridge (rewrite / Q&A / translation via the `claude` CLI),
comments, and an Obsidian inbox importer. It manages *only* the CMS —
formatting, CSS, layout, shared components, rendering pipeline, routing and
deployment all belong to the consuming site. The one deliberate exception
is the **Markdown dialect and content guard** (`astro-inkbrush/markdown` +
`scripts/check-*.mjs`): what the editor accepts and what the page renders
must be a single grammar, so the parser rule set is defined here, once.

## How to run

The package doesn't run standalone in production — it activates inside a
consuming site's dev server. Two ways to work on it:

```bash
# 1. Inside the Inkstone garden — the demo site that consumes this package
#    (it vendors the engine as a git submodule; the garden's notes are the
#    engine's manual, under its /inkbrush/ chapters):
git clone --recurse-submodules https://github.com/ventusff/astro-inkstone
cd astro-inkstone && npm install && cd demo && npm install
npm run wiki          # WIKI=1 astro dev — CMS active
npm run build         # reading mode; output must be engine-free

# 2. The test suite (pure library modules, Node's native type stripping):
npm test
```

## The site-integration contract (changes here affect every consumer)

- `inkbrush({ markdown })` integration: injects the client, mounts the
  `/api/wiki/*` middleware, runs server init. `markdown` carries the site's
  own remark/rehype plugins and its note-id → URL rule, so the editor
  preview, the save-time validation and the AI gate render a note the way
  the page does. Dev-mode only; it must inject **nothing** outside WIKI
  mode — byte-identical builds are the hard line.
- `rehypeWikiBlocks`: sites add it (WIKI mode only) to their pipeline for
  block ↔ source-line mapping.
- `astro-inkbrush/markdown` → `markdownProcessor({ remarkPlugins,
  rehypePlugins, guard })`: the base of a site's Markdown pipeline
  (disables Astro's own GFM and re-mounts the dialect ahead of site
  plugins).
- `astro-inkbrush/wikilinks`: the single `[[wikilink]]` implementation
  (transform factory + resolver + the prose extractor built on the
  dialect's parser), pipeline-agnostic, shared by site rendering, editor
  preview, backlink indexes and the inbox importer. Pass `{ mdx: true }`
  when the source is MDX, or JSX-wrapped prose is masked as HTML.
- `scripts/check-content.mjs` / `scripts/check-wikilinks.mjs` /
  `scripts/check-dist.mjs`: standalone check CLIs that import the dialect
  and link rules from the package root. Given `--config`, the first two
  also mount the site's own plugins and resolver; without it they check
  the dialect and the guard only, and say so.
- `<meta name="inkbrush-note" content="<note id>">`: a note page declares
  its identity; the client never parses URLs. Optional
  `inkbrush-note-url` template for locale jumps.
- DOM slots (all optional): `[data-inkbrush-slot="account"]` for the
  account chip (the mounted chip itself carries
  `data-wiki-role="account"` — the stable client-side hook) (falls back to fixed top-right, tunable via
  `--wiki-chip-top/right`), `[data-inkbrush-slot="share"]` (required for
  the share button), `[data-inkbrush-slot="comments"]` for the comment
  section mount (falls back to a `.note-main .col` container),
  `[data-inkbrush-slot="frontmatter"]` on the element that renders the
  frontmatter (page head, meta strip) — the ✎ handle for the YAML block
  binds there (required: no slot, no frontmatter block).
- `inkbrush.config.ts` (site root, per-machine, gitignored) +
  `defineInkbrushConfig`: auth / identity / inbox / autocommit / autopush /
  claude / content / share. CMS concerns only — no site business.
- `astro-inkbrush/session` → `currentUser(req)`: a **read-only** identity
  contract for sibling data planes in the same process. Read is exported;
  issuing, logout and provider flows never leave the package.
  Authorization decisions belong to the caller.

## Hard rules

- Every path the server touches — notes, assets, inbox files, AI job
  changes — is resolved through `server/paths.ts` and must stay inside its
  root; every write goes through `store.ts` (atomic, under the in-process
  lock). AI jobs never work in the project: they run in a `workspace.ts`
  copy against a start-of-job snapshot, their changes pass `validate.ts`
  plus a per-job postcondition (a block edit changes nothing in the note
  outside its block; a translation changes nothing but its target), and a file that changed in the project meanwhile
  refuses the whole application — a concurrent manual edit always wins.
- Child processes (claude jobs, snapshot builds) receive an allowlisted
  environment — deployment secrets never reach them. API responses never
  carry a member's email except to that member or an admin.

- Naming boundary: **inkbrush** is the component name (package,
  integration, config, meta tags, slots); **wiki** is the feature name
  (`WIKI=1`, `WIKI_*` env, `/api/wiki`, `.wiki/` state, UI copy). Keep
  them apart.
- The content directory (`config content.dir`) is the content repo's
  working tree: outside the CMS's own autocommit/autopush, perform zero
  git operations there; never read, modify or commit `inbox/**`.
- Zero static pollution is the bottom line: non-WIKI builds must not
  contain a single injected byte.
- The browser-local playground (`astro-inkbrush/playground`) is the one
  sanctioned exception, and only by a site's explicit opt-in: a DEMO build
  that imports it ships the block editor against an IndexedDB-backed
  transport — every edit stays in the visitor's browser, nothing reaches
  the repo or other visitors. It is never part of the integration, never
  injected, and consumer sites must not mount it. A build that does mount
  it also ships block stamps and a sources manifest, and declares the shape
  to check-dist with `--playground`; default builds keep the full check and
  stay byte-identical.
- UI strings live in `src/wiki/client/strings.ts` (English + Chinese,
  selected by the page's `<html lang>`); server messages are English.
- Comments and documentation are English; the README and manual ship in
  English and Simplified Chinese — keep the pairs in sync. Commit
  messages: English, entirely — subject and body.

## Doc map

`README.md` / `README.zh-CN.md` (positioning + integration contract) ·
`docs/manual.md` / `docs/manual.zh-CN.md` (deployment-facing feature
manual) · `inkbrush.config.example.ts` (annotated config template) ·
`deploy/README.md` (the two-service deployment skeleton)

## How to verify

```bash
npm test                                  # unit tests (node:test, native TS)
npm run typecheck                         # tsc --noEmit
```

The integration build — an Astro site consuming the engine, `check-dist`
over its output, the content CLIs over its notes — runs in the
astro-inkstone repository, whose demo garden vendors this engine.
