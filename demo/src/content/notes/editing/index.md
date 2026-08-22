---
title: Editing, block by block
description: The ✎ flow — CodeMirror in place, a live preview, and two safety nets.
---

Editing here works the way fixing a typo on Wikipedia does: you edit the
paragraph you are looking at, not a giant textarea holding the whole page.

Hover this paragraph in editing mode and click ✎. The rendered block hides,
and a [CodeMirror](https://codemirror.net/) editor expands in its place with
the block's Markdown source. A live preview renders below it as you type —
produced by the **same parser** that renders the page, so the preview never
lies. `⌘/Ctrl + Enter` saves; `Esc` cancels.

## The two safety nets

**Optimistic locking.** Each block carries a hash of the source it was cut
from. If someone else changed the file under you, the save is rejected with
a conflict instead of silently overwriting their work — refresh and retry.

**A compile gate.** Before anything is written to disk, the whole file is
re-compiled with the site's exact Markdown dialect. A save that would break
the page — an unclosed component tag, a malformed expression — is refused
with the compiler's error, and the file on disk stays untouched.

## Where saves go

A save writes the Markdown file and, with `autocommit` enabled, becomes a
git commit authored by the signed-in user. There is no database anywhere:
your content files are the single source of truth, and git is the history.
The fine-grained per-block journal that powers [[revisions]] rides on top.

The dialect itself — GFM with a CJK-friendly emphasis rule, plus a content
guard that refuses silently-deforming Markdown — is defined once in the
engine and shared by the page renderer, this editor's preview, and the
`check-content` CLI. The zh mirror of the welcome note shows the CJK rule
at work.
