/**
 * [[ autocomplete — a CodeMirror 6 CompletionSource: typing `[[` lists the
 * notes a wikilink can name from THIS note, each as the spelling that
 * resolves to it here (lib/wikilink-core.ts wikilinkCandidates — the
 * resolver's rules read backwards, over the deployment's locale table the
 * page's meta carries): the note's own language, spelled without the
 * locale prefix; another language only once its prefix is typed (`de/`).
 * Matching is substring (CJK-friendly, not per-character fuzzy) over the
 * spelling, brand, aliases and title, ranked spelling-prefix →
 * spelling-substring → brand/alias → title; an empty query lists the whole
 * language. Selecting inserts `spelling]]` (a `|label` is left for the
 * author to add); the title shows beside each entry, brand and aliases in
 * the info panel.
 * The list comes from GET /api/wiki/notes (see the TTL cache below).
 * IME: CodeMirror holds transactions during composition, so completion only
 * fires after text is committed — no special-casing needed.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';

import { wikilinkCandidates } from '../../lib/wikilink-core.ts';
import type { NoteListItem, NotesResponse } from '../shared/types';
import { api } from './api';
import type { PageContext } from './index';

// 60s TTL: long-lived pages pick up notes created elsewhere without a full
// reload. Only successful responses are cached — a failed fetch clears the
// slot so the next keystroke retries immediately.
const NOTES_TTL_MS = 60_000;
let notesCacheAt = 0;
let notesCache: Promise<NoteListItem[]> | null = null;
const loadNotes = (): Promise<NoteListItem[]> => {
  if (!notesCache || Date.now() - notesCacheAt > NOTES_TTL_MS) {
    notesCacheAt = Date.now();
    const request = api.get<NotesResponse>('/notes').then((r) => r.notes);
    notesCache = request;
    request.catch(() => {
      if (notesCache === request) notesCache = null;
    });
  }
  return notesCache;
};

function wikilinkSource(ctx: PageContext) {
  return async (cm: CompletionContext): Promise<CompletionResult | null> => {
    // stays active after `[[` until ]] / | / # / newline
    const m = cm.matchBefore(/\[\[[^\][\n|#]*/);
    if (!m) return null;
    if (m.from === m.to && !cm.explicit) return null;

    // a failed list fetch means "no completions", never a thrown source
    let notes: NoteListItem[];
    try {
      notes = await loadNotes();
    } catch {
      return null;
    }
    const candidates = wikilinkCandidates({
      notes,
      locales: ctx.meta.locales,
      fromNoteId: ctx.meta.id,
      query: m.text.slice(2),
    });

    const options: Completion[] = candidates.map(({ spelling, note }) => {
      const knownAs = [note.brand, ...note.aliases].filter((s): s is string => Boolean(s));
      return {
        label: spelling,
        detail: note.title === spelling ? '' : note.title,
        ...(knownAs.length > 0 ? { info: knownAs.join(' · ') } : {}),
        apply: (view, _completion, from, to) => {
          const after = view.state.sliceDoc(to, to + 2);
          const closing = after === ']]' ? '' : ']]';
          view.dispatch({
            changes: { from, to, insert: `${spelling}${closing}` },
            selection: { anchor: from + spelling.length + closing.length },
          });
        },
      };
    });

    return { from: m.from + 2, options, filter: false };
  };
}

export function wikilinkCompletion(ctx: PageContext) {
  return autocompletion({ override: [wikilinkSource(ctx)], icons: false });
}
