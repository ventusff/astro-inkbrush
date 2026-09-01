# Contributing to astro-inkbrush

Thank you for taking the time. This page is the short version; `AGENTS.md`
is the full working guide and applies to humans and coding agents alike.

## Before you start

- **Where things belong.** Inkbrush is the editing engine: the dev-server
  CMS (block editing, revisions, comments, AI assist, the inbox, shares),
  the Markdown dialect and content guard, the check CLIs and the browser
  playground. It ships no styling beyond its own chrome. Page appearance,
  layout, components and the rendering pipeline belong to the site or to the
  design layer, [astro-inkstone](https://github.com/ventusff/astro-inkstone),
  whose demo is also this engine's manual.
- **Talk first about anything user-facing.** Open a
  [discussion](https://github.com/ventusff/astro-inkbrush/discussions) or an
  issue before a feature; bug fixes and documentation fixes can go straight
  to a pull request.

## Setup and verification

```bash
git clone https://github.com/ventusff/astro-inkbrush
cd astro-inkbrush && npm ci
npm test            # unit tests (node --test over test/**/*.test.ts)
npm run typecheck   # tsc --noEmit
```

End-to-end behavior is exercised by the astro-inkstone demo: its
`playground_probe` drives the editor in headless Chrome, and its
`check-content` run covers every note's block map.

## What pull requests are checked against

- Every save-path change keeps the two gates: the optimistic lock and the
  whole-file compile; every stamp change keeps the block-map invariants
  (`src/lib/wiki-blocks-check.ts`).
- A static build stays engine-free (`check-dist` holds the line); the
  playground stays opt-in.
- Comments and documentation in English; commit messages entirely in
  English, a subject line and a body that says why. No build artifacts in a
  commit.

## Reporting

Bugs and feature requests go through the issue templates; security problems
through [SECURITY.md](SECURITY.md).
