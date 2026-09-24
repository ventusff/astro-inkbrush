/**
 * syndication-transform — a unit as the peer will hold it.
 *
 * The copy differs from the original in exactly three ways, each decided
 * here from the origin's knowledge of both wikis:
 *
 *  - frontmatter: the peer's value map rewrites classification values
 *    (`domains: [ai]` → `[llm]`, a null mapping drops the value), the
 *    note's own per-peer overrides (`syndication.<peer>`) replace whole
 *    fields, and `syndication` itself never travels. Each change is a
 *    surgical edit of the key it touches.
 *  - wikilinks: a link the peer will resolve to the same note as the
 *    origin stays as written; one the peer would resolve elsewhere (a
 *    title the peer also uses, a locale mirror it lacks) is rewritten to
 *    the explicit id; one pointing at a note the peer will not have — a
 *    note outside this unit that is not one of this wiki's copies there —
 *    becomes its visible text, escaped, and is reported.
 *  - root-relative links: a Markdown link to such a note becomes its
 *    text; an image or a JSX href/src is left alone and reported.
 *
 * Every other byte of every file passes unchanged, and every edited note
 * is verified (lib/syndication-links.ts): its parsed tree must equal the
 * original's with the degraded links as their text and the rewritten
 * ones as their new spelling — a degrade that would change the structure
 * around it refuses the unit rather than guessing. The transform is a
 * function of its inputs alone — same inputs, same bytes, same digest.
 */
import type { DegradedLink, SyndicationRefusal, SyndicationWarning } from '../wiki/shared/types.ts';
import { setFrontmatterFields } from './frontmatter-edit.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { escapeBlockStarts, escapeMarkdownInline } from './markdown-escape.ts';
import { digest, isNoteFile, noteIdOfPath, stableJson, unitOf, type Bundle } from './syndication-bundle.ts';
import { expectedTree, linkShape, sameLinks, sameTree, type LinkShape, type NodePath, type Replacement } from './syndication-links.ts';
import { buildWikilinkResolver, findWikilinks, type WikiNoteInfo, type WikilinkResolver } from './wikilink-core.ts';
import { noteInfoFromSource, parseSourceTree, type SourceNode } from './wikilinks.ts';

/** field → source value → the peer's value (null drops the value) */
export type ValueMap = Record<string, Record<string, string | null>>;

/** a peer's note as the origin knows it: `origin` names the wiki it is a copy of */
export interface PeerNoteInfo extends WikiNoteInfo {
  origin: string | null;
}

export interface TransformInput {
  unit: string;
  /** the unit's original files (collectUnit) */
  files: Bundle;
  peer: { id: string; map: ValueMap };
  /** this wiki's locale table */
  locales: readonly { prefix: string }[];
  /** the peer's locale table */
  peerLocales: readonly { prefix: string }[];
  /** this wiki's notes, for resolving the unit's links as its pages do */
  originNotes: readonly WikiNoteInfo[];
  /** this wiki's note-id → URL rule, for reading its root-relative links */
  urlForOrigin: (id: string) => string;
  /** the peer's notes as they are */
  peerNotes: readonly PeerNoteInfo[];
  /** this wiki's name on the peer (`origin.wiki` of its copies there) */
  originName: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  /** the note's frontmatter in the copy */
  fields: Record<string, unknown>;
}

export type TransformResult =
  | {
      ok: true;
      bundle: Bundle;
      digest: string;
      notes: NoteSummary[];
      degraded: DegradedLink[];
      warnings: SyndicationWarning[];
    }
  | { ok: false; refusals: SyndicationRefusal[] };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/* ---------------- frontmatter ---------------- */

/** the frontmatter as the copy carries it: the value map, then the
 *  per-peer overrides, without `syndication` */
function copyFields(data: Record<string, unknown>, peer: TransformInput['peer']): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [field, values] of Object.entries(peer.map)) {
    const value = data[field];
    if (typeof value === 'string') {
      if (Object.hasOwn(values, value)) {
        if (values[value] === null) delete out[field];
        else out[field] = values[value];
      }
    } else if (Array.isArray(value)) {
      const mapped: unknown[] = [];
      for (const item of value) {
        const next = typeof item === 'string' && Object.hasOwn(values, item) ? values[item] : item;
        if (next !== null && !mapped.includes(next)) mapped.push(next);
      }
      out[field] = mapped;
    }
  }
  const overrides = data['syndication'];
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const own = (overrides as Record<string, unknown>)[peer.id];
    if (own && typeof own === 'object' && !Array.isArray(own)) {
      for (const [key, value] of Object.entries(own as Record<string, unknown>)) {
        if (value === null) delete out[key];
        else out[key] = value;
      }
    }
  }
  delete out['syndication'];
  return out;
}

/** the fields whose value in the copy differs from the original (`undefined` = removed) */
function fieldChanges(data: Record<string, unknown>, copy: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(data), ...Object.keys(copy)])) {
    if (!(key in copy)) changes[key] = undefined;
    else if (!(key in data) || stableJson(copy[key]) !== stableJson(data[key])) changes[key] = copy[key];
  }
  return changes;
}

/* ---------------- links ---------------- */

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function offsetsOf(node: SourceNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? [start, end] : null;
}

/** the origin note a root-relative URL addresses (longest URL prefix wins), or null */
function noteOfUrl(url: string, urls: Array<[url: string, id: string]>): string | null {
  const path = url.replace(/[?#].*$/, '');
  for (const [prefix, id] of urls) {
    if (path === prefix || path.startsWith(prefix)) return id;
  }
  return null;
}

/* ---------------- the transform ---------------- */

export function transformUnit(input: TransformInput): TransformResult {
  const { unit, peer } = input;
  const notePaths = [...input.files.keys()].filter(isNoteFile).sort();
  const refusals: SyndicationRefusal[] = [];
  if (!input.files.has(`${unit}/index.md`) && !input.files.has(`${unit}/index.mdx`)) {
    refusals.push({ code: 'no-root', note: unit });
  }

  // frontmatter first: the copy's note infos feed the peer-side resolver
  const texts = new Map<string, string>();
  const summaries: NoteSummary[] = [];
  const copyInfos: WikiNoteInfo[] = [];
  for (const path of notePaths) {
    const id = noteIdOfPath(path);
    const text = decoder.decode(input.files.get(path)!);
    const fm = splitFrontmatter(text);
    if (!fm.present) {
      refusals.push({ code: 'no-frontmatter', note: id });
      continue;
    }
    if (fm.error) {
      refusals.push({ code: 'frontmatter', note: id, detail: fm.error.message });
      continue;
    }
    if (fm.data['syndication'] === false) refusals.push({ code: 'never', note: id });
    if ('origin' in fm.data) refusals.push({ code: 'copy', note: id });
    let next = text;
    let fields: Record<string, unknown>;
    try {
      fields = copyFields(fm.data, peer);
      const changes = fieldChanges(fm.data, fields);
      if (Object.keys(changes).length > 0) next = setFrontmatterFields(text, changes);
    } catch (err) {
      refusals.push({ code: 'frontmatter', note: id, detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const info = noteInfoFromSource(id, next);
    texts.set(path, next);
    summaries.push({ id, title: info.title, fields });
    copyInfos.push(info);
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const resolveOrigin: WikilinkResolver = buildWikilinkResolver({
    notes: () => [...input.originNotes],
    urlFor: input.urlForOrigin,
    locales: input.locales.map((l) => ({ code: l.prefix, prefix: l.prefix })),
  });
  // the peer's notes after this publish: its own minus this unit, plus the copy
  const peerAfter = new Map<string, PeerNoteInfo>();
  for (const note of input.peerNotes) {
    if (unitOf(note.id, input.peerLocales) !== unit) peerAfter.set(note.id, note);
  }
  const available = (id: string): boolean =>
    copyInfos.some((n) => n.id === id) || peerAfter.get(id)?.origin === input.originName;
  const resolvePeer: WikilinkResolver = buildWikilinkResolver({
    notes: () => [...peerAfter.values(), ...copyInfos],
    urlFor: (id) => `/${id}/`,
    locales: input.peerLocales.map((l) => ({ code: l.prefix, prefix: l.prefix })),
  });
  const urls = input.originNotes
    .map((n): [string, string] => [input.urlForOrigin(n.id), n.id])
    .sort(([a], [b]) => b.length - a.length);

  const degraded: DegradedLink[] = [];
  const warnings: SyndicationWarning[] = [];
  const bundle: Bundle = new Map();
  for (const path of [...input.files.keys()].sort()) {
    if (!isNoteFile(path)) {
      bundle.set(path, input.files.get(path)!);
      continue;
    }
    const from = noteIdOfPath(path);
    const text = texts.get(path)!;
    const mdx = path.endsWith('.mdx');

    const tree = parseSourceTree(text, { mdx });
    /** an edit of the source and what it is in the tree */
    const planned: Array<Edit & { replacement: Replacement; target: string }> = [];

    /** the wikilinks the copy must make: the kept and the rewritten, in order */
    const intended: LinkShape[] = [];
    for (const link of findWikilinks(tree, text)) {
      const written = link.anchor ? `${link.target}#${link.anchor}` : link.target;
      const at = resolveOrigin(link.target, from);
      const id = at.kind === 'ok' ? at.id : null;
      const keepable = id !== null && available(id);
      const there = resolvePeer(link.target, from);
      const sameThere = keepable && there.kind === 'ok' && there.id === id;
      if (!link.span) {
        // a match that cannot be placed in the source cannot be edited: kept
        // when the peer resolves the spelling to the same note, refused otherwise
        if (sameThere) intended.push(linkShape(link));
        else refusals.push({ code: 'degrade', note: from, target: written });
        continue;
      }
      const textEdit = (replacement: string, expected: string): void => {
        planned.push({
          ...link.span!,
          text: replacement,
          target: written,
          replacement: { kind: 'text', path: link.path, valueStart: link.valueStart, valueEnd: link.valueEnd, text: expected },
        });
      };
      const degrade = (): void => {
        textEdit(escapeMarkdownInline(link.shown), link.shown);
        degraded.push({ note: from, target: written, shown: link.shown });
      };
      if (!keepable) {
        degrade();
        continue;
      }
      if (sameThere) {
        intended.push(linkShape(link));
        continue;
      }
      // the explicit id with the decoded anchor and visible text, spelled
      // inertly: kept only when the peer resolves that id to the same note (a
      // locale mirror can shadow a bare id)
      const spelled = resolvePeer(id, from);
      if (spelled.kind !== 'ok' || spelled.id !== id) {
        degrade();
        continue;
      }
      const anchor = link.anchor ? `#${link.anchor}` : '';
      textEdit(
        `[[${id}${link.anchor ? `#${escapeMarkdownInline(link.anchor)}` : ''}|${escapeMarkdownInline(link.shown)}]]`,
        `[[${id}${anchor}|${link.shown}]]`,
      );
      intended.push([id, link.anchor ?? null, link.shown]);
    }

    // reference-style links and images point where their definitions do:
    // the first definition of an identifier
    const definitions = new Map<string, string>();
    const collect = (node: SourceNode): void => {
      if (node.type === 'definition' && node.identifier !== undefined && typeof node.url === 'string' && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      node.children?.forEach(collect);
    };
    collect(tree);
    const urlOf = (node: SourceNode): string | null => {
      const url =
        node.type === 'link' || node.type === 'image'
          ? node.url
          : node.type === 'linkReference' || node.type === 'imageReference'
            ? definitions.get(node.identifier ?? '')
            : undefined;
      return typeof url === 'string' && url.startsWith('/') ? url : null;
    };
    const walk = (node: SourceNode, path: NodePath): void => {
      const url = urlOf(node);
      if (url) {
        const target = noteOfUrl(url, urls);
        if (target !== null && !available(target)) {
          const range = offsetsOf(node);
          if ((node.type === 'link' || node.type === 'linkReference') && range) {
            const children = node.children ?? [];
            const first = children[0] && offsetsOf(children[0]);
            const last = children[children.length - 1] && offsetsOf(children[children.length - 1]!);
            const shown = first && last ? text.slice(first[0], last[1]) : '';
            planned.push({ start: range[0], end: range[1], text: escapeBlockStarts(shown), target: url, replacement: { kind: 'unwrap', path } });
            degraded.push({ note: from, target: url, shown });
          } else warnings.push({ note: from, url, kind: 'image' });
        }
      }
      for (const attribute of node.attributes ?? []) {
        if (attribute.type !== 'mdxJsxAttribute' || (attribute.name !== 'href' && attribute.name !== 'src')) continue;
        const value = attribute.value;
        if (typeof value !== 'string' || !value.startsWith('/')) continue;
        const target = noteOfUrl(value, urls);
        if (target !== null && !available(target)) warnings.push({ note: from, url: value, kind: 'element' });
      }
      node.children?.forEach((child, i) => walk(child, [...path, i]));
    };
    walk(tree, []);

    // the copy must read as the original with the links replaced; when it
    // does not, the edits are replayed one at a time to name the first
    // that breaks the reading
    planned.sort((a, b) => b.start - a.start);
    const verified = (count: number): boolean => {
      const edits = planned.slice(0, count);
      const copySource = applyEdits(text, edits);
      const copy = parseSourceTree(copySource, { mdx });
      if (!sameTree(copy, expectedTree(tree, edits.map((e) => e.replacement)))) return false;
      // with every edit in, the copy's wikilinks must be exactly the intended
      // ones; a partial replay is judged by its tree alone
      return count < planned.length || sameLinks(copy, copySource, intended);
    };
    if (refusals.some((r) => r.code === 'degrade' && r.note === from)) continue;
    if ((planned.length > 0 || intended.length > 0) && !verified(planned.length)) {
      const failing = planned.findIndex((_e, i) => !verified(i + 1));
      refusals.push({ code: 'degrade', note: from, target: planned[failing === -1 ? 0 : failing]!.target });
      continue;
    }
    bundle.set(path, encoder.encode(applyEdits(text, planned)));
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, bundle, digest: digest(bundle), notes: summaries, degraded, warnings };
}
