---
title: The Obsidian inbox
description: Point the watcher at a vault folder; new notes import themselves.
---

Plenty of writing starts somewhere else — a phone, a clipper, an Obsidian
vault. The inbox closes that loop: point it at a folder, and notes dropped
there import themselves into the site.

## Turning it on

The demo ships with the inbox off. Enable it in `inkbrush.config.ts`:

```ts
inbox: {
  dir: '~/vault/inbox',        // the folder to watch (supports ~/)
  ignore: ['daily-'],          // optional: filename prefixes to skip
},
```

Files already in the folder at startup are marked as seen, not imported —
only notes added *afterwards* sync automatically. Anything older can be
backfilled explicitly through the API, so turning the inbox on never dumps
a decade of vault history onto your site by surprise.

## What the importer does

Each incoming note is converted, not copied:

- image embeds are resolved against the vault's asset folders, the files
  are **copied next to the imported note**, and the embeds become standard
  image syntax — deleting the note later deletes its assets with it
- `[[wikilinks]]` that match a real note on this site survive as links; the
  rest are flattened to plain emphasis with a warning
- highlights become real `<mark>` elements, frontmatter metadata becomes a
  source line under the title, and a description is derived from the first
  substantive paragraph

Every import lands in the revision journal (via: inbox) as a whole-file
record: ⟲ lists it as an audit row, and undoing an import is a git
operation. With `autocommit` on, each import also becomes a git commit like
any other edit — this demo keeps autocommit off, so imported files arrive
as ordinary working-tree changes to review and commit yourself.
