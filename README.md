<h1 align="center">astro-inkbrush</h1>

<p align="center"><b>A tiny git-backed CMS for Astro — edit your static site in place.</b></p>

<p align="center">
  <a href="https://github.com/ventusff/astro-inkbrush/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ventusff/astro-inkbrush/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2b2622"></a>
  <img alt="Astro 7" src="https://img.shields.io/badge/Astro-7-b6552e?logo=astro&logoColor=white">
</p>

<p align="center">
  <a href="https://ventusff.github.io/astro-inkbrush/"><b>Demo notes site&nbsp;→</b></a>
  &nbsp;·&nbsp;
  <a href="docs/manual.md">Manual</a>
  &nbsp;·&nbsp;
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img alt="a notes page in reading mode, and the same page with a block open in the in-place editor" src=".github/assets/demo-preview.png" width="920">
</p>

**Inkbrush** (笔 — the ink brush) adds an optional editing layer to any Astro
site: hover a paragraph, click ✎, edit the Markdown source right there, save —
the page hot-reloads, and with `autocommit` on the change is a git commit. No
database, no admin panel, no separate authoring app. Your content files stay
the single source of truth; git stays the history.

It is the sibling of [**astro-inkstone**](https://github.com/ventusff/astro-inkstone)
(砚 — the ink stone), a paper-and-ink design layer. Inkbrush styles only its
own editing chrome (through tokens it takes from your page) and ships no page
styling and no layout — bring your own site, or pair it with Inkstone for
the full look. **See the editor in motion** — formulas, tables, `[[wikilinks]]`
and the frontmatter edited in place, the guard refusing a broken save — in the
[Inkstone README](https://github.com/ventusff/astro-inkstone#readme), and try it
yourself in the browser on the
[Inkstone demo](https://ventusff.github.io/astro-inkstone/kitchen-sink/).

## Features

- ✏️ **In-place block editing** — Wikipedia-style, per block. CodeMirror 6
  with a live server-rendered preview that runs your site's own Markdown
  plugins, `[[` autocompletion scoped to the note's language, optimistic
  locking (a block changed by
  someone else is refused, never overwritten), and a whole-file build gate —
  the dialect, the content guard, your plugins, MDX compilation — before
  anything is written. The frontmatter is a block too, edited as YAML from
  the page head.
- 🕘 **Block-level revision history** — every save is journaled with a
  unique id; browse a block's history and revert a block edit in one click
  (whole-file operations — imports, translations — are journaled for the
  record and reverted through git).
- 🤖 **AI assist** — rewrite a block, chat about the current note, or
  generate a full translation of a note into another locale — via the
  `claude` CLI, streaming progress live. Every job runs in a throwaway
  workspace holding only the note (and the companion files your config
  names), with file tools confined to it, no shell or network tools and an
  allowlisted environment; its result is validated like a manual save and
  carried back only then — and only if nothing changed under the job
  meanwhile: a concurrent manual edit wins.
- 💬 **Comments** — Markdown + math, server-sanitized, stored as flat
  NDJSON files under `.wiki/data/` beside your project; author emails
  never leave the server.
- 📥 **Obsidian inbox** — watch a vault folder; new notes are converted
  (embeds copied beside the note and referenced relatively, wikilinks
  resolved with the same parser the pages use, highlights preserved) and
  imported automatically.
- 🔗 **Wikilinks** — one `[[wikilink]]` implementation shared by the page
  pipeline, the editor preview and the importer: aliases, anchors, locale
  mirrors, and dead-link spans instead of broken builds.
- 🔐 **Sign-in options** — instant dev login (loopback-only by default),
  Google OAuth (PKCE, a browser-bound single-use state), or Google
  Workspace SAML SSO (every response must answer a request this server
  issued); domain allowlists are fail-closed; HMAC-cookie or JWT
  sessions (cross-subdomain SSO); an optional file-based member registry —
  when it is on, only current members can edit, and only admins can manage
  it.
- 📤 **Password-gated sharing** — snapshot a single note (with its full
  asset closure) into a static bundle and publish it through a tiny
  gateway API you can implement in an afternoon.
- 🧾 **A Markdown dialect with a conscience** — GFM + CJK-friendly
  emphasis, defined once and used in three places (page rendering, save
  validation, editor preview), plus a build-time **content guard** that
  fails the build on silent deformations: unpaired `*`/`_`/`~~`, MDX
  expressions swallowing your prose, single-line `$$x$$`, formulas KaTeX
  can't render, and more — each reported with file:line:column and a caret.
- 🩺 **Check CLIs** — `check-content.mjs` (compile every source file with
  the dialect, the guard and — given `--config` — your site's plugins;
  given `--frontmatter`, hold every file's frontmatter to your
  content-collection schema before the build does),
  `check-wikilinks.mjs` (dead or ambiguous `[[wikilinks]]`, dubious
  anchors — with the library's own parser and resolution rules) and
  `check-dist.mjs` (broken links, dangling anchors, locale doubling, nested
  `<a>`, KaTeX error residue, and any CMS injection in built HTML).
- 🪶 **Zero production footprint** — the integration does nothing outside
  `astro dev`, and `check-dist` fails a build that carries any of its bytes.
- 🧪 **Browser-local playground** (`astro-inkbrush/playground`) — an opt-in
  surface for demo sites only: the same block editor on a static build,
  saving to the visitor's own IndexedDB. Nothing leaves the browser;
  consumer sites never mount it (the build that does declares itself with
  `check-dist --playground`).

## How it works

```
readers   →  your static build (astro build) — nginx, Pages, object storage…
authors   →  the same repo running `WIKI=1 astro dev` on an editing domain
              └─ saves → git commits (autocommit) → pushed (autopush) → CI rebuilds
```

The editor is Astro's dev server with this integration active: an
"edit-and-it's-live" surface needs a resident compiler, and the dev server
is exactly that. Sessions, a membership registry and cross-site request
checks make it fit for a real domain; the reader-facing site never runs any
of it. A two-service deployment skeleton (static reader + editing machine)
ships in [`deploy/`](deploy/README.md).

## Quick start

The demo is the [Inkstone garden](https://ventusff.github.io/astro-inkstone/):
this engine's own manual lives there as
[the editing machine](https://ventusff.github.io/astro-inkstone/inkbrush/)
chapters (in 18 languages), and the browser playground on that site runs this
very editor on a purely static build. To edit for real, run the garden in
editing mode — it vendors this engine as a git submodule:

```bash
git clone --recurse-submodules https://github.com/ventusff/astro-inkstone
cd astro-inkstone && npm install
cd demo && npm install
npm run wiki        # WIKI=1 astro dev → open the site, sign in (dev login), edit away
npm run build       # reading mode — proof of the zero-footprint claim
```

## Adding it to your site

Three touches, all gated on an env flag (vendor the repo as a git submodule
and declare it with pnpm `workspace:*` or npm `file:` — it isn't on npm,
by design):

```ts
// astro.config.ts
import { inkbrush, rehypeWikiBlocks } from 'astro-inkbrush';
import { markdownProcessor } from 'astro-inkbrush/markdown';

const WIKI_MODE = process.env.WIKI === '1' || process.env.WIKI === 'true';

const remarkPlugins = [/* yours */];
const rehypePlugins = [/* yours */];

export default defineConfig({
  markdown: {
    processor: markdownProcessor({
      remarkPlugins,
      rehypePlugins: [...rehypePlugins, ...(WIKI_MODE ? [rehypeWikiBlocks] : [])],
    }),
  },
  // the same plugins go to the CMS, so its preview and its save-time
  // validation render a note the way your pages do; urlFor is your
  // note-id → URL rule — without it the engine assumes `/${id}/`;
  // frontmatter is your content-collection schema, so a save is refused
  // for the frontmatter the build would refuse
  integrations: [...(WIKI_MODE ? [inkbrush({ markdown: { remarkPlugins, rehypePlugins, urlFor: (id) => `/notes/${id}/`, frontmatter: notesSchema } })] : [])],
});
```

```astro
<!-- on each note page: tell the CMS which note this is (routing stays yours) -->
<meta name="inkbrush-note" content={noteId} />
```

```bash
cp <path-to-inkbrush>/inkbrush.config.example.ts inkbrush.config.ts   # optional, per machine
WIKI=1 astro dev
```

No config file is required — the default is dev-login-only with everything
else off. See the [manual](docs/manual.md) for auth providers, the identity
registry, the inbox, sharing, and every configuration key.

## Who does what

```
astro-inkbrush   the brush — editing: block CMS, revisions, comments, AI,
                 inbox, Markdown dialect + content guard
astro-inkstone   the stone — appearance: tokens, content styles, components,
                 pipeline preset (builds on this package's dialect)
your site        the hand — identity: layout, routing, content, deployment
```

The one thing Inkbrush *does* define beyond the CMS is the **Markdown
dialect** — because a block the editor accepts must render identically on
the page, the parser rule set lives in one place and is consumed everywhere.

## License

[MIT](LICENSE) © Jianfei Guo
