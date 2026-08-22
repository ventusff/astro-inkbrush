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
# 1. The in-repo demo (a small multi-note site consuming the package):
npm install && cd demo && npm install
npm run wiki          # WIKI=1 astro dev — CMS active
npm run build         # reading mode; output must be engine-free

# 2. The test suite (pure library modules, Node's native type stripping):
npm test
```

## The site-integration contract (changes here affect every consumer)

- `inkbrush()` integration: injects the client, mounts the `/api/wiki/*`
  middleware, runs server init. Dev-mode only; it must inject **nothing**
  outside WIKI mode — byte-identical builds are the hard line.
- `rehypeWikiBlocks`: sites add it (WIKI mode only) to their pipeline for
  block ↔ source-line mapping.
- `astro-inkbrush/markdown` → `markdownProcessor({ remarkPlugins,
  rehypePlugins, guard })`: the base of a site's Markdown pipeline
  (disables Astro's own GFM and re-mounts the dialect ahead of site
  plugins).
- `astro-inkbrush/wikilinks`: the single `[[wikilink]]` implementation
  (transform factory + resolver), pipeline-agnostic, shared by site
  rendering, editor preview and the inbox importer.
- `scripts/check-content.mjs` / `scripts/check-dist.mjs`: standalone check
  CLIs that import the dialect from the package root — zero drift from the
  site's plugin set by construction.
- `<meta name="inkbrush-note" content="<note id>">`: a note page declares
  its identity; the client never parses URLs. Optional
  `inkbrush-note-url` template for locale jumps.
- DOM slots (all optional): `[data-inkbrush-slot="account"]` for the
  account chip (falls back to fixed top-right, tunable via
  `--wiki-chip-top/right`), `[data-inkbrush-slot="share"]` (required for
  the share button), `[data-inkbrush-slot="comments"]` for the comment
  section mount (falls back to a `.note-main .col` container).
- `inkbrush.config.ts` (site root, per-machine, gitignored) +
  `defineInkbrushConfig`: auth / identity / inbox / autocommit / autopush /
  claude / content / share. CMS concerns only — no site business.
- `astro-inkbrush/session` → `currentUser(req)`: a **read-only** identity
  contract for sibling data planes in the same process. Read is exported;
  issuing, logout and provider flows never leave the package.
  Authorization decisions belong to the caller.

## Hard rules

- Naming boundary: **inkbrush** is the component name (package,
  integration, config, meta tags, slots); **wiki** is the feature name
  (`WIKI=1`, `WIKI_*` env, `/api/wiki`, `.wiki/` state, UI copy). Keep
  them apart.
- The content directory (`config content.dir`) is the content repo's
  working tree: outside the CMS's own autocommit/autopush, perform zero
  git operations there; never read, modify or commit `inbox/**`.
- Zero static pollution is the bottom line: non-WIKI builds must not
  contain a single injected byte.
- UI strings live in `src/wiki/client/strings.ts` (English + Chinese,
  selected by the page's `<html lang>`); server messages are English.
- Comments and documentation are English; the README and manual ship in
  English and Simplified Chinese — keep the pairs in sync. Commit messages:
  English subject line; a Chinese mirror line in the body is welcome.

## Doc map

`README.md` (positioning + integration contract) · `docs/manual.md` /
`docs/manual.zh-CN.md` (deployment-facing feature manual) ·
`inkbrush.config.example.ts` (annotated config template)
