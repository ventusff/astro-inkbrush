---
title: AI assist
description: Block rewrites, a note-aware chat, and whole-note translation — via the claude CLI.
---

The ✦ actions bridge to the [`claude` CLI](https://claude.com/claude-code).
They need it installed and signed in on the machine running the dev server —
nothing else on this site does. No CLI, no problem: everything except this
page's ✦ buttons works without it.

## Rewrite a block

Hover a block, click ✦, and either pick a quick intent — polish, make it
more rigorous, condense, fix the formulas — or type your own instruction.
The job runs server-side in a throwaway copy of the note's directory, with
file tools confined to that copy — no shell, no network — and streams its
progress live; it survives the browser tab closing. When it ends, the
changed file has to pass the same build gate as a manual save before it is
carried back into the project and journaled, so [[revisions]] can undo it.

## Ask about the note

The chat panel (the floating button, bottom right) answers questions about
the note you are reading. Claude reads the source in a working copy with
a read-only toolset; follow-up questions resume the same conversation.

## Translate the whole note

For each locale a note lacks, the chat panel offers a one-click "generate
version" — not a literal translation, but the note re-told in the target
language by an author who keeps every anchor, code block and structural
invariant intact. The result is written as the mirror file (for this site,
under `zh/`), and the build gate has the final word before anything is
kept. A translation is a whole-file change: the journal records it, and
undoing it is a git operation rather than a ⟲ click.
