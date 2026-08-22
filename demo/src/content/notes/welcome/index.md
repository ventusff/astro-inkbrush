---
title: Welcome to Field Notes
description: What this site is, and how to open it in editing mode.
---

This little site is a **working demo of astro-inkbrush** — a tiny git-backed
CMS for Astro. Every page you see is a plain Markdown file in
`src/content/notes/`, rendered by a completely ordinary Astro site with its
own completely ordinary stylesheet. The engine adds one thing: the ability to
edit these files *on the page*.

## Two ways to run it

Reading mode is what you are looking at:

```bash
cd demo && npm install
npm run build        # or: npm run dev
```

Editing mode is where it gets interesting:

```bash
npm run wiki         # WIKI=1 astro dev
```

Open the site, click **Sign in** in the header (the demo uses the local
quick sign-in — name and email, no password), then hover any paragraph on
any note. A small handle appears in the margin with three actions:

- ✎ — edit the block's Markdown source in place ([[editing]])
- ✦ — ask Claude to rewrite the block ([[ai-assist]])
- ⟲ — this block's revision history, with one-click revert ([[revisions]])

## Where to go next

Start with [[editing]] for the core loop, then [[wikilinks]] for how notes
link to each other, and [[inbox]] for pulling notes in from an Obsidian
vault. The essay [[garden-craft]] is here as a specimen — a note that is
about notes.

There is also a Chinese mirror of this page — the language link in the
breadcrumbs jumps between locales. In editing mode, notes without a mirror
get a one-click "generate translation" button instead.

> Everything on this site is honest: the build you are reading contains not
> a single byte of CMS code. Editing exists only in dev mode.
