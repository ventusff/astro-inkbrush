/**
 * wikilink-core — the [[wikilink]] grammar, resolver and remark transform
 * (subpath export astro-inkbrush/wikilinks/core).
 *
 * Browser-safe by construction: no Node builtins, no parser construction,
 * no frontmatter dependency — the module is loaded by the playground's
 * activation chunk and by any browser-side render pipeline, so everything
 * it imports ships to visitors. The filesystem scanner and the source-level
 * extractor (which parse whole documents with the MDX grammar) live in
 * ./wikilinks.ts, which re-exports this module for server and CLI callers.
 *
 * Syntax: [[target]] · [[target|label]] · [[target#anchor]] (![[embed]] is
 * handled elsewhere).
 * Resolution order: source note's locale mirror → exact id → alias → brand →
 * title (case-insensitive).
 * A miss never fails the build: it renders span.wikilink-dead and fires
 * onBroken; strict checking belongs to lint.
 *
 * The locale rule — which locale an id lives in — is localePrefixOf, the one
 * definition the resolver, the editor's [[ completion (wikilinkCandidates,
 * the resolver read backwards) and the servers' note metadata share.
 *
 * A backslash-escaped opener (`\[[x]]`, `[\[x]]`) is literal text, never a
 * wikilink. The transform sees the parsed tree, where the parser has already
 * consumed the escape, so it maps each match back to the vfile source
 * (walking from the text node's start offset, two source characters per
 * escaped one) and skips matches spelled with an escape. The mapping is
 * conservative: without a source string on the file, without a start offset
 * on the node, or past the first point where the node's text diverges from
 * the source (a character reference, entity or other non-literal), matches
 * are treated as unescaped — the spelling can then no longer be read from
 * the source.
 */
/** shared regex; capture groups: 1=target 2=anchor? 3=label?
 *  (?<!!) excludes ![[embed]]; (?!\() excludes [[1]](#ref)-style markdown
 *  link text (the citation-footnote idiom — [[x]](y) is always a markdown
 *  link, never a wikilink) */
export const WIKILINK_RE = /(?<!!)\[\[([^\][|#\n]+)(?:#([^\][|\n]*))?(?:\|([^\][\n]+))?\]\](?!\()/g;

export interface WikiNoteInfo {
  id: string;
  title: string;
  brand?: string | undefined;
  aliases: string[];
}

export type WikilinkResolution =
  | { kind: 'ok'; id: string; url: string; title: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] };

export type WikilinkResolver = (target: string, fromNoteId?: string) => WikilinkResolution;

// the uninjected fallback locale table; the registry of record is
// src/wiki/shared/locales.ts — the code/prefix pairs must agree (the
// default locale's '' prefix names no mirror and is not listed here)
const DEFAULT_LOCALES = [
  { code: 'en', prefix: 'en/' },
  { code: 'de', prefix: 'de/' },
];

/** default anchor slugifier, matching the usual heading-slug plugin rules
 *  (e.g. astro-inkstone's); sites should inject their own explicitly */
export function defaultSlugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[\s·/]+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/* ---------------- locale rule ---------------- */

/**
 * The locale prefix an id lives under: the table's prefix it carries (the
 * bare locale segment — an id equal to `zh` — counts as that locale), else
 * '' — the default locale, whose notes live unprefixed. Tables with or
 * without a row for the default locale read the same.
 */
export function localePrefixOf(id: string, locales: readonly { prefix: string }[]): string {
  for (const l of locales) {
    if (l.prefix !== '' && (id === l.prefix.slice(0, -1) || id.startsWith(l.prefix))) return l.prefix;
  }
  return '';
}

/* ---------------- resolver ---------------- */

interface ResolverMaps {
  byId: Map<string, WikiNoteInfo>;
  byKey: Map<string, string[]>; // normalized alias/brand/title → note ids
}

export function buildWikilinkResolver(opts: {
  /** the note list (caching is the caller's business — builds pass a one-shot
   *  array, dev passes cachedScan) */
  notes: () => WikiNoteInfo[];
  /** id → site URL (sites pass their noteUrl; previews pass (id) => `/${id}/`) */
  urlFor: (id: string) => string;
  locales?: { code: string; prefix: string }[];
}): WikilinkResolver {
  const locales = opts.locales ?? DEFAULT_LOCALES;
  let lastNotes: WikiNoteInfo[] | null = null;
  let maps: ResolverMaps | null = null;

  const norm = (s: string): string => s.trim().toLowerCase();

  const mapsFor = (notes: WikiNoteInfo[]): ResolverMaps => {
    if (maps && lastNotes === notes) return maps;
    const byId = new Map<string, WikiNoteInfo>();
    const byKey = new Map<string, string[]>();
    const add = (key: string, id: string): void => {
      const k = norm(key);
      if (!k) return;
      const list = byKey.get(k) ?? [];
      if (!list.includes(id)) list.push(id);
      byKey.set(k, list);
    };
    for (const n of notes) {
      byId.set(n.id, n);
      for (const a of n.aliases) add(a, n.id);
      if (n.brand) add(n.brand, n.id);
      add(n.title, n.id);
    }
    lastNotes = notes;
    maps = { byId, byKey };
    return maps;
  };

  return (target, fromNoteId) => {
    const { byId, byKey } = mapsFor(opts.notes());
    const t = target.trim();

    const ok = (id: string): WikilinkResolution => {
      const note = byId.get(id);
      return { kind: 'ok', id, url: opts.urlFor(id), title: note?.title ?? id };
    };

    // 1) the source note's locale mirror wins ([[X]] inside an en note → en/X
    //    when it exists); the default locale's empty prefix names no mirror
    const fromPrefix = fromNoteId === undefined ? '' : localePrefixOf(fromNoteId, locales);
    if (fromPrefix && byId.has(`${fromPrefix}${t}`)) return ok(`${fromPrefix}${t}`);
    // 2) exact id (including explicit en/-prefixed spellings)
    if (byId.has(t)) return ok(t);
    // 3) alias / brand / title (case-insensitive; multiple hits = ambiguous)
    const hits = byKey.get(norm(t));
    if (hits && hits.length === 1) return ok(hits[0]!);
    if (hits && hits.length > 1) return { kind: 'ambiguous', candidates: hits };
    return { kind: 'missing' };
  };
}

/* ---------------- completion candidates ---------------- */

export interface WikilinkCandidate {
  /** the text between the brackets that resolves to `note` from the source note */
  spelling: string;
  note: WikiNoteInfo;
}

/** match score of a candidate against the typed text: smaller sorts first;
 *  null = no match. Substring matching (CJK queries work per character
 *  run), case-insensitive. */
function candidateRank(spelling: string, note: WikiNoteInfo, query: string): number | null {
  if (!query) return 100;
  const s = spelling.toLowerCase();
  if (s.startsWith(query)) return 0;
  if (s.includes(query)) return 1;
  if (note.brand?.toLowerCase().includes(query)) return 2;
  if (note.aliases.some((a) => a.toLowerCase().includes(query))) return 2;
  if (note.title.toLowerCase().includes(query)) return 3;
  return null;
}

/**
 * The notes a [[wikilink]] typed inside `fromNoteId` can name, each with
 * the spelling that resolves to it there — the resolver's rules read
 * backwards, over the same notes and locale table:
 *
 *  - the source note's own locale, spelled without its locale prefix (the
 *    mirror rule takes `guide` typed in `zh/other` to `zh/guide`; in the
 *    default locale the spelling is the id itself). Notes of other locales
 *    are not offered: a link typed in a language names that language's
 *    pages;
 *  - a locale whose prefix the author spells (`de/`) — that locale's notes
 *    by their full id (the exact-id rule).
 *
 * `query` is the text typed so far; a candidate stays when its spelling,
 * brand, an alias or its title contains it (case-insensitive substring).
 * Order: spelling prefix → spelling substring → brand or alias → title, then
 * by spelling. Every spelling returned resolves to its note from
 * `fromNoteId` through buildWikilinkResolver.
 */
export function wikilinkCandidates(opts: {
  notes: readonly WikiNoteInfo[];
  locales?: readonly { prefix: string }[] | undefined;
  /** the note being edited; absent → the default locale */
  fromNoteId?: string | undefined;
  query?: string | undefined;
}): WikilinkCandidate[] {
  const locales = opts.locales ?? DEFAULT_LOCALES;
  const query = (opts.query ?? '').trim().toLowerCase();
  const own = opts.fromNoteId === undefined ? '' : localePrefixOf(opts.fromNoteId, locales);
  // a spelled prefix opens that locale by full id (the own locale included:
  // `zh/guide` typed in a zh note is an exact id too)
  const spelled = locales.find((l) => l.prefix !== '' && query.startsWith(l.prefix.toLowerCase()));
  const scope = spelled ? spelled.prefix : own;
  const strip = spelled ? '' : own;

  const scored: { candidate: WikilinkCandidate; score: number }[] = [];
  for (const note of opts.notes) {
    if (localePrefixOf(note.id, locales) !== scope) continue;
    // the bare locale segment (an id equal to `zh`) has no local spelling:
    // its full id is the exact one
    const spelling = strip && note.id.startsWith(strip) ? note.id.slice(strip.length) : note.id;
    const score = candidateRank(spelling, note, query);
    if (score !== null) scored.push({ candidate: { spelling, note }, score });
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.spelling.localeCompare(b.candidate.spelling));
  return scored.map((s) => s.candidate);
}

/* ---------------- remark transform ---------------- */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** the transformer receives whatever node shape the pipeline produces; the
 *  source offset is read structurally so MdNode stays assignable from the
 *  pipeline's own Node type */
function startOffsetOf(node: MdNode): number | undefined {
  return (node as { position?: { start?: { offset?: number } } }).position?.start?.offset;
}

/**
 * Whether the `[[` of a match at `matchIndex` in a text node's value is
 * spelled with a backslash escape (`\[[` or `[\[`) in the source. Walks the
 * source from the node's start offset in lockstep with the value, consuming
 * two source characters wherever a backslash escapes the next one. Returns
 * false as soon as source and value diverge (a character reference or other
 * non-literal): from there the spelling cannot be read, and an unverifiable
 * match must stay a wikilink.
 */
function escapedInSource(source: string, sourceStart: number, value: string, matchIndex: number): boolean {
  let si = sourceStart;
  for (let vi = 0; vi <= matchIndex + 1 && vi < value.length; vi += 1) {
    const c = value[vi]!;
    if (source[si] === '\\' && source[si + 1] === c) {
      if (vi === matchIndex || vi === matchIndex + 1) return true;
      si += 2;
    } else if (source[si] === c) {
      si += 1;
    } else if (c === '\n') {
      // line-suffix whitespace and the CR of a CRLF are not part of the value
      while (source[si] === ' ' || source[si] === '\t') si += 1;
      if (source[si] === '\r') si += 1;
      if (source[si] !== '\n') return false;
      si += 1;
    } else {
      return false;
    }
  }
  return false;
}

const NO_DESCEND = new Set(['link', 'linkReference', 'code', 'inlineCode', 'math', 'inlineMath']);

export interface BrokenWikilink {
  file?: string | undefined;
  target: string;
  kind: 'missing' | 'ambiguous';
}

export function remarkWikilinks(opts: {
  resolve: WikilinkResolver;
  slugifyAnchor?: (raw: string) => string;
  /** derive the source note id from the compiled file path (for locale-aware resolution) */
  noteIdOf?: (filePath: string | undefined) => string | undefined;
  onBroken?: (b: BrokenWikilink) => void;
}) {
  const slug = opts.slugifyAnchor ?? defaultSlugify;

  return (tree: MdNode, file?: { path?: string; value?: unknown }): void => {
    const fromId = opts.noteIdOf?.(file?.path);
    const source = typeof file?.value === 'string' ? file.value : null;

    const transformText = (node: MdNode): MdNode[] | null => {
      const value = node.value ?? '';
      WIKILINK_RE.lastIndex = 0;
      if (!WIKILINK_RE.test(value)) return null;
      WIKILINK_RE.lastIndex = 0;

      const nodeStart = startOffsetOf(node);
      const out: MdNode[] = [];
      let last = 0;
      let replaced = false;
      for (const m of value.matchAll(WIKILINK_RE)) {
        const [raw, target, anchor, label] = m as unknown as [
          string,
          string,
          string | undefined,
          string | undefined,
        ];
        const idx = m.index ?? 0;
        // an escaped opener is literal text: leave its span for the
        // surrounding text slices
        if (source !== null && nodeStart !== undefined && escapedInSource(source, nodeStart, value, idx)) {
          continue;
        }
        replaced = true;
        if (idx > last) out.push({ type: 'text', value: value.slice(last, idx) });
        last = idx + raw.length;

        const shown = (label ?? (anchor ? `${target}#${anchor}` : target)).trim();
        const res = opts.resolve(target, fromId);
        if (res.kind === 'ok') {
          out.push({
            type: 'link',
            url: anchor ? `${res.url}#${slug(anchor)}` : res.url,
            title: res.title,
            data: { hProperties: { className: ['wikilink'], 'data-note': res.id } },
            children: [{ type: 'text', value: shown }],
          });
        } else {
          const tip =
            res.kind === 'ambiguous'
              ? `ambiguous target: ${res.candidates.join(' / ')}`
              : `no such note: ${target.trim()}`;
          out.push({
            type: 'wikilinkDead',
            data: {
              hName: 'span',
              hProperties: { className: ['wikilink', 'wikilink-dead'], title: tip },
            },
            children: [{ type: 'text', value: shown }],
          });
          opts.onBroken?.({ file: file?.path, target: target.trim(), kind: res.kind });
        }
      }
      if (!replaced) return null;
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
      return out;
    };

    const walk = (node: MdNode): void => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]!;
        if (NO_DESCEND.has(child.type)) continue;
        if (child.type === 'text') {
          const replaced = transformText(child);
          if (replaced) {
            children.splice(i, 1, ...replaced);
            i += replaced.length - 1;
          }
          continue;
        }
        walk(child);
      }
    };
    walk(tree);
  };
}
