---
title: Revision history and revert
description: Every save is journaled per block — browse it with ⟲, undo it in one click.
---

Every save on this site — whether typed by hand, produced by Claude, or
imported from the inbox — is appended to a revision journal alongside the
content: who, when, which lines, and the exact before/after text.

Hover a block and click ⟲ to see that block's history. Each entry shows how
the change was made (manual edit, Claude edit, AI translation, inbox
import, or an earlier revert), by whom, and a collapsible before/after diff.

## Revert

One click on an entry's revert button replaces that revision's *after* text
with its *before* text — as a new journaled edit, so a revert is itself
revertible. Two details worth knowing:

- The revert is applied by exact content match. If the block has since been
  edited so the old text no longer appears verbatim, the revert is refused
  rather than guessed — nothing is ever fuzzily patched.
- The result passes through the same compile gate as any other save. A
  revert that would break the page is rejected.

## Why both a journal and git?

Git (via `autocommit`) is the durable, whole-file history — the thing you
push, back up and diff. The journal is the fine-grained layer that makes ⟲
instant and per-block. They answer different questions: *"what happened to
this file?"* versus *"what happened to this paragraph?"*
