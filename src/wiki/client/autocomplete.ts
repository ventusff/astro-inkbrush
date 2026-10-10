/**
 * Editor completions for the two ways a note points elsewhere.
 *
 * [[ — a CodeMirror 6 CompletionSource: typing `[[` lists the
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
 * the info panel. The list comes from GET /api/wiki/notes.
 *
 * @ — typing `@` where a mention can start (lib/mentions.ts: not after a
 * letter, digit or one of `_ . / \ @ -`; not inside code, a link, an
 * image, a URL, HTML or inline math — where the page renders none) lists the
 * site's members from GET /api/wiki/identity/people, each as their name
 * beside an initial, with the handle that will be written. The query
 * matches the handle and every word of the name from its start, then
 * anywhere; selecting writes `@handle`, which the page renders as the
 * member's current name.
 *
 * Both lists are cached for a minute (see the TTL cache below); the members
 * list is read again at once when this page saves a name (PEOPLE_CHANGED).
 * IME: CodeMirror holds transactions during composition, so completion only
 * fires after text is committed — no special-casing needed.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';

import { wikilinkCandidates } from '../../lib/wikilink-core.ts';
import type { NoteListItem, NotesResponse, PeopleResponse, PersonView } from '../shared/types';
import { api } from './api';
import type { PageContext } from './index';
import { PEOPLE_CHANGED } from './people-events';
import { h } from './ui';

// 60s TTL: long-lived pages pick up notes created (and members added or
// renamed) elsewhere without a full reload. Only successful responses are
// cached — a failed fetch clears the slot so the next keystroke retries.
const LIST_TTL_MS = 60_000;
function cachedList<T>(load: () => Promise<T[]>, forgetOn?: string): () => Promise<T[]> {
  let at = 0;
  let cache: Promise<T[]> | null = null;
  if (forgetOn) window.addEventListener(forgetOn, () => (cache = null));
  return () => {
    if (!cache || Date.now() - at > LIST_TTL_MS) {
      at = Date.now();
      const request = load();
      cache = request;
      request.catch(() => {
        if (cache === request) cache = null;
      });
    }
    return cache;
  };
}
const loadNotes = cachedList(() => api.get<NotesResponse>('/notes').then((r) => r.notes));
const loadPeople = cachedList(() => api.get<PeopleResponse>('/identity/people').then((r) => r.people), PEOPLE_CHANGED);

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

/** markdown syntax nodes (@codemirror/lang-markdown) the mention transform never enters */
const NO_MENTION_NODES = /Code|Link|Image|URL|HTML|Comment|ProcessingInstruction/;

/** an odd number of unescaped `$` before the cursor on its line: inline math is open */
const insideMath = (lineBefore: string): boolean => (lineBefore.match(/(?<!\\)\$/g)?.length ?? 0) % 2 === 1;

/** a character after which `@` can start a mention (lib/mentions.ts MENTION_RE's lookbehind) */
const MENTION_BLOCKED_BEFORE = /[A-Za-z0-9_./\\@-]/;

/** members ranked for a query: handle or a name word starting with it, then containing it */
export function rankPeople(people: readonly PersonView[], query: string): PersonView[] {
  const q = query.toLowerCase();
  if (q === '') return [...people].sort((a, b) => a.name.localeCompare(b.name));
  const score = (p: PersonView): number => {
    const name = p.name.toLowerCase();
    if (p.handle.startsWith(q) || name.startsWith(q)) return 0;
    if (name.split(/[\s._-]+/).some((w) => w.startsWith(q))) return 1;
    if (p.handle.includes(q) || name.includes(q)) return 2;
    return -1;
  };
  return people
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

function mentionSource() {
  return async (cm: CompletionContext): Promise<CompletionResult | null> => {
    const m = cm.matchBefore(/@[A-Za-z0-9._-]*/);
    if (!m) return null;
    if (MENTION_BLOCKED_BEFORE.test(cm.state.sliceDoc(m.from - 1, m.from))) return null;
    // only where the page renders mentions: not in code, links, images, URLs, HTML or math
    for (let node = syntaxTree(cm.state).resolveInner(m.from, 1); ; node = node.parent) {
      if (NO_MENTION_NODES.test(node.name)) return null;
      if (!node.parent) break;
    }
    if (insideMath(cm.state.sliceDoc(cm.state.doc.lineAt(m.from).from, m.from))) return null;
    let people: PersonView[];
    try {
      people = await loadPeople();
    } catch {
      return null;
    }
    const options: Completion[] = rankPeople(people, m.text.slice(1)).map((p) => ({
      label: `@${p.handle}`,
      displayLabel: p.name,
      detail: `@${p.handle}`,
      type: 'mention',
      // a letter, digit or one of `. _ - @` right after would run into the handle: a space keeps them apart
      apply: (view, _completion, from, to) => {
        const gap = /[A-Za-z0-9._@-]/.test(view.state.sliceDoc(to, to + 1)) ? ' ' : '';
        const insert = `@${p.handle}${gap}`;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      },
    }));
    if (options.length === 0) return null;
    return { from: m.from, options, filter: false };
  };
}

/** a member's initial on a tinted disc, before their name in the list */
function personMark(completion: Completion): Node | null {
  if (completion.type !== 'mention') return null;
  const initial = [...(completion.displayLabel ?? completion.label)][0]?.toUpperCase() ?? '@';
  return h('span', { class: 'wiki-mention-mark', 'aria-hidden': 'true' }, initial);
}

/** [[ and @ completions for the markdown editor */
export function noteCompletion(ctx: PageContext) {
  return autocompletion({
    override: [wikilinkSource(ctx), mentionSource()],
    icons: false,
    addToOptions: [{ render: personMark, position: 20 }],
    optionClass: (c) => (c.type === 'mention' ? 'wiki-completion-person' : ''),
  });
}
