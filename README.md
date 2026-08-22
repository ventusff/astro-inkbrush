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
  <img alt="the demo notes site: reading mode, and the same page with a block open in the in-place editor" src=".github/assets/demo-preview.png" width="920">
</p>

**Inkbrush** (笔 — the ink brush) adds an optional editing layer to any Astro
site: hover a paragraph, click ✎, edit the Markdown source right there, save —
the page hot-reloads and the change is a git commit. No database, no admin
panel, no separate authoring app. Your content files stay the single source
of truth; git stays the history.

It is the sibling of [**astro-inkstone**](https://github.com/ventusff/astro-inkstone)
(砚 — the ink stone), a paper-and-ink design layer. Inkbrush deliberately
ships **no styling and no layout** — bring your own site, or pair it with
Inkstone for the full look.

## Features

- ✏️ **In-place block editing** — Wikipedia-style, per block. CodeMirror 6
  with live server-rendered preview, `[[` autocompletion, optimistic
  locking, and a whole-file MDX compile gate before anything is written.
- 🕘 **Block-level revision history** — every save is journaled; browse a
  block's history and revert any edit in one click.
- 🤖 **AI assist** — rewrite a block, chat about the current note (the
  assistant reads the source server-side), or generate a full translation of
  a note into another locale — via the `claude` CLI, streaming progress
  live, with a locked-down toolset.
- 💬 **Comments** — Markdown + math, server-sanitized, stored as flat
  NDJSON files next to your content.
- 📥 **Obsidian inbox** — watch a vault folder; new notes are converted
  (embeds resolved and co-located, wikilinks remapped, highlights
  preserved) and imported automatically.
- 🔗 **Wikilinks** — one `[[wikilink]]` implementation shared by the page
  pipeline, the editor preview and the importer: aliases, anchors, locale
  mirrors, and dead-link spans instead of broken builds.
- 🔐 **Sign-in options** — instant dev login, Google OAuth, or Google
  Workspace SAML SSO; HMAC-cookie or JWT sessions (cross-subdomain SSO);
  an optional file-based member registry with roles.
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
  the exact production dialect) and `check-dist.mjs` (broken links, dangling
  anchors, locale doubling, nested `<a>`, KaTeX error residue in built HTML).
- 🪶 **Zero production footprint** — the CMS activates only in dev mode.
  `astro build` output is byte-identical to a site that never installed it.

## How it works

```
readers   →  your static build (astro build) — nginx, Pages, object storage…
authors   →  the same repo running `WIKI=1 astro dev` on an editing domain
              └─ saves → git commits (autocommit) → pushed (autopush) → CI rebuilds
```

The editor is Astro's dev server with this integration active: an
"edit-and-it's-live" surface needs a resident compiler, and the dev server
is exactly that. Auth, sessions and roles make it safe to put behind a real
domain; the reader-facing site never runs any of it. A ready-made two-service
deployment skeleton (static reader + editing machine) ships in the sibling
repo's [`deploy/`](https://github.com/ventusff/astro-inkstone/tree/main/deploy).

## Quick start

Run the demo — a small multi-note site with the editor wired up:

```bash
git clone https://github.com/ventusff/astro-inkbrush
cd astro-inkbrush && npm install
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

const WIKI_MODE = Boolean(process.env.WIKI);

export default defineConfig({
  markdown: {
    processor: markdownProcessor({
      remarkPlugins: [/* yours */],
      rehypePlugins: [/* yours */, ...(WIKI_MODE ? [rehypeWikiBlocks] : [])],
    }),
  },
  integrations: [...(WIKI_MODE ? [inkbrush()] : [])],
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
