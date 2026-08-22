/**
 * wikilinks — THE [[wikilink]] implementation (subpath export
 * astro-inkbrush/wikilinks).
 *
 * Pipeline-agnostic transform factory + resolver + fs scanner, shared by all
 * three consumers — the site's rendering pipeline, the in-package preview
 * pipeline (server/markdown.ts), and the Obsidian importer — so parsing can
 * never drift. Composition belongs to the caller: the site injects its own
 * noteUrl/slugify/onBroken; this file stays zero-dependency (not even
 * unist-util-visit, same style as rehype-wiki-blocks).
 *
 * Syntax: [[target]] · [[target|label]] · [[target#anchor]] (![[embed]] is
 * handled elsewhere).
 * Resolution order: source note's locale mirror → exact id → alias → brand →
 * title (case-insensitive).
 * A miss never fails the build: it renders span.wikilink-dead and fires
 * onBroken; strict checking belongs to lint.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

// this file is a zero-dependency standalone library (composition belongs to
// the caller) — this table is only the uninjected fallback; the registry of
// record is src/wiki/shared/locales.ts, keep the two in sync
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

    // 1) the source note's locale mirror wins ([[X]] inside an en note → en/X when it exists)
    const fromPrefix = locales.find((l) => fromNoteId?.startsWith(l.prefix))?.prefix ?? '';
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

/* ---------------- remark transform ---------------- */

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: Record<string, unknown>;
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

  return (tree: MdNode, file?: { path?: string }): void => {
    const fromId = opts.noteIdOf?.(file?.path);

    const transformText = (node: MdNode): MdNode[] | null => {
      const value = node.value ?? '';
      WIKILINK_RE.lastIndex = 0;
      if (!WIKILINK_RE.test(value)) return null;
      WIKILINK_RE.lastIndex = 0;

      const out: MdNode[] = [];
      let last = 0;
      for (const m of value.matchAll(WIKILINK_RE)) {
        const [raw, target, anchor, label] = m as unknown as [
          string,
          string,
          string | undefined,
          string | undefined,
        ];
        const idx = m.index ?? 0;
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

/* ---------------- fs scan (frontmatter title/brand/aliases) ---------------- */

function frontmatterBlock(source: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(source);
  return m ? m[1]! : null;
}

function fmScalar(fm: string, field: string): string | undefined {
  const line = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(fm);
  if (!line) return undefined;
  const v = line[1]!.trim().replace(/^['"]|['"]$/g, '');
  return v || undefined;
}

/** aliases: both the inline `[a, b]` and the block-list `- a` YAML forms are accepted */
function fmStringList(fm: string, field: string): string[] {
  const inline = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, 'm').exec(fm);
  if (inline) {
    return inline[1]!
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
  }
  const block = new RegExp(`^${field}:\\s*$([\\s\\S]*?)(?=^\\S|$(?![\\s\\S]))`, 'm').exec(fm);
  if (!block) return [];
  return [...block[1]!.matchAll(/^\s+-\s+(.+)$/gm)].map((m) =>
    m[1]!.trim().replace(/^['"]|['"]$/g, ''),
  );
}

/** scan <contentDir>/**\/index.{mdx,md} → WikiNoteInfo[] (skips _meta and dot dirs) */
export function scanNotes(contentDir: string): WikiNoteInfo[] {
  const notes: WikiNoteInfo[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // conventional non-note directories: _meta/ (registries) and docs/
      // (a content repo's internal archives) are not notes
      if (name === '_meta' || name === 'docs' || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (/^index\.mdx?$/.test(name)) {
        const id = relative(contentDir, dir).replaceAll('\\', '/');
        if (!id) continue;
        const fm = frontmatterBlock(readFileSync(p, 'utf8'));
        notes.push({
          id,
          title: (fm && fmScalar(fm, 'title')) ?? id,
          brand: fm ? fmScalar(fm, 'brand') : undefined,
          aliases: fm ? fmStringList(fm, 'aliases') : [],
        });
      }
    }
  };
  walk(contentDir);
  return notes;
}

/** TTL-memoized scanNotes (dev picks up new notes; builds amortize to one scan) */
export function cachedScan(contentDir: string, ttlMs = 2000): () => WikiNoteInfo[] {
  let at = 0;
  let cache: WikiNoteInfo[] | null = null;
  return () => {
    const now = Date.now();
    if (!cache || now - at > ttlMs) {
      cache = scanNotes(contentDir);
      at = now;
    }
    return cache;
  };
}

/* ---------------- source-level extraction (backlink indexes / importer / lint) ---------------- */

export interface ExtractedWikilink {
  target: string;
  anchor?: string | undefined;
  label?: string | undefined;
  /** offset into the pre-mask original (masking replaces at equal length, so offsets stay valid) */
  offset: number;
  raw: string;
}

/** blank out frontmatter, ``` fences and `inline code` at equal length (offsets unchanged) */
export function maskNonProse(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  let s = source.replace(/^---\n[\s\S]*?\n---/, blank);
  s = s.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1`*[^\n]*$/gm, blank);
  s = s.replace(/`[^`\n]+`/g, blank);
  return s;
}

export function extractWikilinks(source: string): ExtractedWikilink[] {
  const masked = maskNonProse(source);
  const out: ExtractedWikilink[] = [];
  WIKILINK_RE.lastIndex = 0;
  for (const m of masked.matchAll(WIKILINK_RE)) {
    out.push({
      target: m[1]!.trim(),
      anchor: m[2]?.trim(),
      label: m[3]?.trim(),
      offset: m.index ?? 0,
      raw: m[0]!,
    });
  }
  return out;
}
