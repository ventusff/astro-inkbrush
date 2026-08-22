---
title: Wikilinks
description: Double-bracket links between notes — aliases, anchors, and honest dead links.
---

Notes here link to each other with double brackets. Writing `[[welcome]]`
renders as [[welcome]] — a normal link, resolved at build time against the
set of notes that actually exist.

## What a target can be

A target doesn't have to be a note's id. Resolution tries, in order: the
current locale's mirror, the exact id, then aliases, brand names and titles
(case-insensitively). The essay [[garden-craft]] declares `tending` as an
alias, so `[[tending]]` lands on the same page: [[tending]].

Anchors and labels compose the way you'd hope:

- `[[garden-craft#pruning]]` → [[garden-craft#pruning]] — straight to a
  section
- `[[garden-craft|the gardening essay]]` → [[garden-craft|the gardening essay]]
  — custom link text

## Dead links don't break builds

A link to a note that doesn't exist — say, [[compost-heap]] — renders as a
visibly dead link with the reason in its tooltip, and the build logs a
warning. This is a deliberate choice for gardens: an unwritten note is an
invitation, not an error. (A target matching several notes at once renders
the same way, marked ambiguous.)

## One implementation, three consumers

The same resolver runs in the page pipeline, in the editor's live preview,
and in the [[inbox]] importer — so a link means the same thing everywhere.
In editing mode, typing `[[` in the editor pops up autocompletion over ids,
titles and aliases.
