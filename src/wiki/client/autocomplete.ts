/**
 * [[ autocomplete — a CodeMirror 6 CompletionSource: typing `[[` lists the
 * site's notes with substring matching (CJK-friendly, not per-character
 * fuzzy) over id / title / brand / aliases, ranked id-prefix → id-substring
 * → brand/alias → title; an empty query lists everything.
 * Selecting inserts `id]]` (a `|label` is left for the author to add;
 * detail/info show the brand and full title for reference).
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

import type { NoteListItem, NotesResponse } from '../shared/types';
import { api } from './api';

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

/** substring hit score: smaller sorts first; null = no hit */
function rank(note: NoteListItem, query: string): number | null {
  if (!query) return 100;
  const id = note.id.toLowerCase();
  if (id.startsWith(query)) return 0;
  if (id.includes(query)) return 1;
  if (note.brand?.toLowerCase().includes(query)) return 2;
  if (note.aliases.some((a) => a.toLowerCase().includes(query))) return 2;
  if (note.title.toLowerCase().includes(query)) return 3;
  return null;
}

async function wikilinkSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  // stays active after `[[` until ]] / | / # / newline
  const m = ctx.matchBefore(/\[\[[^\][\n|#]*/);
  if (!m) return null;
  if (m.from === m.to && !ctx.explicit) return null;
  const query = m.text.slice(2).trim().toLowerCase();

  // a failed list fetch means "no completions", never a thrown source
  let notes: NoteListItem[];
  try {
    notes = await loadNotes();
  } catch {
    return null;
  }
  const scored = notes
    .map((n) => ({ n, score: rank(n, query) }))
    .filter((x): x is { n: NoteListItem; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.n.id.localeCompare(b.n.id));

  const options: Completion[] = scored.map(({ n }) => ({
    label: n.id,
    detail: n.brand ?? '',
    info: n.title,
    apply: (view, _completion, from, to) => {
      const after = view.state.sliceDoc(to, to + 2);
      const closing = after === ']]' ? '' : ']]';
      view.dispatch({
        changes: { from, to, insert: `${n.id}${closing}` },
        selection: { anchor: from + n.id.length + closing.length },
      });
    },
  }));

  return { from: m.from + 2, options, filter: false };
}

export function wikilinkCompletion() {
  return autocompletion({ override: [wikilinkSource], icons: false });
}
