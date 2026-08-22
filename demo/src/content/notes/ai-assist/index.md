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
The job runs server-side against the real file with a locked-down toolset
(read and edit only — no shell, no network), streams its progress live, and
survives the browser tab closing. The result lands in the revision journal
like any other edit, so [[revisions]] can undo it.

## Ask about the note

The chat panel (the floating button, bottom right) answers questions about
the note you are reading. Claude reads the source file directly on the
server with a read-only toolset; follow-up questions resume the same
conversation.

## Translate the whole note

For each locale a note lacks, the chat panel offers a one-click "generate
version" — not a literal translation, but the note re-told in the target
language by an author who keeps every anchor, code block and structural
invariant intact. The result is written as the mirror file (for this site,
under `zh/`), and the compile gate has the final word before anything is
kept.
