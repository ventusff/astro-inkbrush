/**
 * Obsidian inbox sync — OPTIONAL per deployment: watches the vault folder
 * configured in inkbrush.config.ts → inbox.dir (env override WIKI_INBOX_DIR) and
 * converts every NEW note into a site article under
 * src/content/notes/inbox/<slug>/index.md. No dir configured (or empty) =
 * the watcher never starts and the import endpoint refuses.
 *
 *  - Plain .md output (not .mdx) — immune to the JSX escaping pitfalls.
 *  - `![[img|alt]]` embeds: the asset is copied from the note's _assets/
 *    folder into the note dir src/content/notes/inbox/<slug>/ (co-located, so
 *    the site can serve it from the note's own URL) and rewritten to standard
 *    image syntax.
 *  - `[[wikilink]]` → *italic text*; `==x==` → <mark>; single-line `$$x$$`
 *    display math normalized to the three-line form remark-math requires.
 *  - Obsidian frontmatter (author/source/url/saved) becomes a "Source" quote
 *    block at the top of the article.
 *  - `inbox.ignore` (config) skips files by vault-relative path or basename
 *    prefix — e.g. auto-generated daily digests.
 *
 * Files that already exist when the watcher starts are marked as seen and
 * NOT imported (only future notes sync automatically); the manual
 * POST /api/wiki/inbox/import {path} endpoint backfills specific files.
 * State lives in .wiki/data/inbox-sync.json (content hash → re-import on
 * change, same slug).
 */
import { watch, type FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { buildWikilinkResolver, cachedScan } from '../../lib/wikilinks';
import { wikiConfig } from './config';
import type { RouteRegistrar } from './index';
import { fail, json, readBody } from './index';
import { autocommit, journalRevision } from './source';
import { projectRoot, readJson, wikiDataDir, writeJson } from './store';

/** configured watch dir (absolute, ~ expanded) — null = inbox sync disabled */
export function inboxDir(): string | null {
  return wikiConfig().inbox.dir;
}

/* ---------------- sync state ---------------- */

interface SyncState {
  [relPath: string]: { slug: string; hash: string; importedAt: number | null };
}

function stateFile(): string {
  return join(wikiDataDir(), 'inbox-sync.json');
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/* ---------------- obsidian → site markdown ---------------- */

interface ObsidianFrontmatter {
  author?: string;
  source?: string;
  url?: string;
  saved?: string;
}

function parseObsidianNote(raw: string): { fm: ObsidianFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { fm: {}, body: raw };
  const fm: ObsidianFrontmatter = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^(author|source|url|saved):\s*(.+)$/.exec(line.trim());
    if (kv) {
      fm[kv[1] as keyof ObsidianFrontmatter] = kv[2]!
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    }
  }
  return { fm, body: raw.slice(match[0].length) };
}

/** derive the import date: parent folder "YYYY-MM-DD" → frontmatter saved → today */
function noteDate(sourcePath: string, fm: ObsidianFrontmatter): string {
  const dir = basename(dirname(sourcePath));
  if (/^\d{4}-\d{2}-\d{2}$/.test(dir)) return dir;
  const saved = /^(\d{4}-\d{2}-\d{2})/.exec(fm.saved ?? '');
  if (saved) return saved[1]!;
  return new Date().toISOString().slice(0, 10);
}

function slugFor(sourcePath: string, fm: ObsidianFrontmatter): string {
  const hash = createHash('sha256').update(basename(sourcePath)).digest('hex').slice(0, 8);
  return `${noteDate(sourcePath, fm)}-${hash}`;
}

/** first meaningful paragraph, markdown-stripped, for <meta description> */
function deriveDescription(body: string, title: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
      .replace(/[#>*_`~]|\!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    // skip common Chinese clipping boilerplate lines (author/published/source/…)
    // — CJK vaults are a first-class input for this importer
    if (text.length >= 20 && !/^(作者|发布|公众号|来源|原文)[^：:]{0,6}[:：]/.test(text)) {
      return text.length > 150 ? `${text.slice(0, 150)}…` : text;
    }
  }
  return title;
}

export interface ConvertResult {
  slug: string;
  noteDir: string;
  assetsCopied: number;
  warnings: string[];
}

export function convertObsidianNote(sourcePath: string): ConvertResult {
  const raw = readFileSync(sourcePath, 'utf8');
  const { fm, body } = parseObsidianNote(raw);
  const title = basename(sourcePath).replace(/\.md$/, '');
  const slug = slugFor(sourcePath, fm);
  const warnings: string[] = [];

  // assets co-locate with the note (src/content/notes/inbox/<slug>/), so a
  // site that serves note-relative assets picks them up with no extra config.
  const noteDir = join(projectRoot(), wikiConfig().content.dir, 'inbox', slug);
  let assetsCopied = 0;

  /** obsidian keeps embeds in `<note dir>/_assets/<note name>/` */
  const assetRoots = [
    join(dirname(sourcePath), '_assets', title),
    join(dirname(sourcePath), '_assets'),
    dirname(sourcePath),
  ];
  const resolveAsset = (name: string): string | null => {
    for (const root of assetRoots) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  let markdown = body;

  // ![[file|alt]] image/file embeds → copy asset + standard image syntax
  markdown = markdown.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, file: string, alt?: string) => {
    const found = resolveAsset(file.trim());
    if (!found) {
      warnings.push(`embedded asset not found: ${file}`);
      // the surrounding spaces matter: two adjacent embeds would fuse into
      // `]**[`, and CommonMark's rule-of-three refuses to pair those markers,
      // leaking literal asterisks into the prose.
      return ` *[missing attachment: ${file.trim()}]* `;
    }
    mkdirSync(noteDir, { recursive: true });
    copyFileSync(found, join(noteDir, basename(found)));
    assetsCopied++;
    return `![${alt?.trim() ?? ''}](/inbox/${slug}/${encodeURIComponent(basename(found))})`;
  });

  // [[link|label]] wikilinks: resolvable to a site note → kept as a real
  // wikilink (renders as a live link); unresolvable (mostly vault-internal
  // targets) → flattened to italics + warning, so pages don't fill with dead
  // links. Snapshot-at-import semantics: a note created later under the same
  // name is not retroactively linked — acceptable.
  const resolveWikilink = buildWikilinkResolver({
    notes: cachedScan(resolve(projectRoot(), wikiConfig().content.dir)),
    urlFor: (id) => `/${id}/`,
  });
  markdown = markdown.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target: string, label?: string) => {
      const res = resolveWikilink(target.trim());
      if (res.kind === 'ok') {
        const shown = label?.trim();
        return shown && shown !== res.id ? `[[${res.id}|${shown}]]` : `[[${res.id}]]`;
      }
      warnings.push(`unresolved wikilink: ${target.trim()}`);
      return `*${(label ?? target).trim()}*`;
    },
  );

  // ==highlight== → <mark>
  markdown = markdown.replace(/==([^=\n][^=\n]*)==/g, '<mark>$1</mark>');

  // single-line display math → three-line form (remark-math would inline it)
  markdown = markdown.replace(/^\$\$(.+?)\$\$[^\S\n]*$/gm, (_, tex: string) => `$$\n${tex.trim()}\n$$`);

  // source attribution block
  const sourceBits: string[] = [];
  if (fm.source || fm.author) {
    const label = [fm.source, fm.author].filter(Boolean).join(' · ');
    sourceBits.push(fm.url ? `[${label}](${fm.url})` : label);
  } else if (fm.url) {
    sourceBits.push(`[Original link](${fm.url})`);
  }
  if (fm.saved) sourceBits.push(fm.saved.slice(0, 10));
  const attribution = sourceBits.length > 0 ? `> Source: ${sourceBits.join(' · ')}\n\n` : '';

  const description = deriveDescription(markdown, title);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `brand: ${JSON.stringify('Inbox')}`,
    `subtitle: ${JSON.stringify(`Obsidian sync · ${noteDate(sourcePath, fm)}`)}`,
    '---',
  ].join('\n');

  mkdirSync(noteDir, { recursive: true });
  writeFileSync(join(noteDir, 'index.md'), `${frontmatter}\n\n${attribution}${markdown.trim()}\n`);
  return { slug, noteDir, assetsCopied, warnings };
}

/* ---------------- import orchestration ---------------- */

function isInboxNote(path: string): boolean {
  if (!path.endsWith('.md')) return false;
  if (path.includes('/_assets/')) return false;
  // config-driven skip list (inkbrush.config.ts → inbox.ignore): each entry
  // is a prefix of the vault-relative path or of the basename
  const dir = inboxDir();
  const rel = dir ? relative(dir, resolve(path)) : basename(path);
  const name = basename(path);
  for (const entry of wikiConfig().inbox.ignore) {
    if (rel.startsWith(entry) || name.startsWith(entry)) return false;
  }
  return true;
}

export function importNote(sourcePath: string, opts?: { force?: boolean }): ConvertResult | null {
  const dir = inboxDir();
  if (!dir) throw new Error('Inbox is not enabled (inkbrush.config.ts → inbox.dir)');
  const abs = resolve(sourcePath);
  const rel = relative(dir, abs);
  const raw = readFileSync(abs, 'utf8');
  const hash = contentHash(raw);
  const state = readJson<SyncState>(stateFile(), {});
  const existing = state[rel];
  if (!opts?.force && existing?.hash === hash && existing.importedAt !== null) return null;
  const result = convertObsidianNote(abs);
  state[rel] = { slug: result.slug, hash, importedAt: Date.now() };
  writeJson(stateFile(), state);
  journalRevision({
    ts: Date.now(),
    user: 'inbox-sync',
    note: `inbox/${result.slug}`,
    lines: '*',
    via: 'inbox',
    before: '',
    after: `imported from ${rel}`,
  });
  void autocommit(
    relative(projectRoot(), result.noteDir),
    `wiki: inbox/${result.slug} Obsidian import`,
    'inbox-sync',
  );
  console.log(`[wiki inbox] imported "${rel}" → inbox/${result.slug} (${result.assetsCopied} assets)`);
  for (const warning of result.warnings) console.warn(`[wiki inbox]   ⚠ ${warning}`);
  return result;
}

/** mark a pre-existing file as seen without importing it */
function markSeen(dir: string, sourcePath: string): void {
  const rel = relative(dir, resolve(sourcePath));
  const state = readJson<SyncState>(stateFile(), {});
  if (state[rel]) return;
  state[rel] = { slug: '', hash: contentHash(readFileSync(sourcePath, 'utf8')), importedAt: null };
  writeJson(stateFile(), state);
}

/* ---------------- watcher ---------------- */

const WATCHER_KEY = '__wikiInboxWatcher';

export function startInboxWatcher(): void {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals[WATCHER_KEY] as FSWatcher | undefined;
  if (previous) void previous.close();
  delete globals[WATCHER_KEY];

  const dir = inboxDir();
  if (!dir) {
    console.log('[wiki inbox] no watch dir configured (inkbrush.config.ts → inbox.dir) — inbox sync off');
    return;
  }
  if (!existsSync(dir)) {
    console.warn(`[wiki inbox] watch dir does not exist, skipping: ${dir}`);
    return;
  }
  let ready = false;
  const watcher = watch(dir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 120 },
    // assets are read on demand at conversion time — watching the (large)
    // _assets image trees only burns inotify watches
    ignored: (path) => path.includes('/_assets'),
  });
  watcher.on('add', (path) => {
    if (!isInboxNote(path)) return;
    try {
      if (!ready) markSeen(dir, path);
      else importNote(path);
    } catch (err) {
      console.error(`[wiki inbox] import failed for ${path}:`, err);
    }
  });
  watcher.on('change', (path) => {
    if (!ready || !isInboxNote(path)) return;
    // re-import only notes we've imported before (content changed)
    const rel = relative(dir, resolve(path));
    const state = readJson<SyncState>(stateFile(), {});
    if (state[rel]?.importedAt === null) return;
    try {
      importNote(path);
    } catch (err) {
      console.error(`[wiki inbox] re-import failed for ${path}:`, err);
    }
  });
  watcher.on('ready', () => {
    ready = true;
    console.log(`[wiki inbox] watching ${dir}`);
  });
  globals[WATCHER_KEY] = watcher;
}

/* ---------------- routes ---------------- */

export function registerInboxRoutes(on: RouteRegistrar): void {
  on('GET', '/inbox/status', ({ res }) => {
    const state = readJson<SyncState>(stateFile(), {});
    const entries = Object.entries(state);
    json(res, 200, {
      enabled: inboxDir() !== null,
      dir: inboxDir(),
      watching: Boolean((globalThis as Record<string, unknown>)[WATCHER_KEY]),
      seen: entries.length,
      imported: entries.filter(([, v]) => v.importedAt !== null).length,
    });
  });

  on(
    'POST',
    '/inbox/import',
    async ({ req, res }) => {
      const dir = inboxDir();
      if (!dir) return fail(res, 400, 'Inbox is not enabled (inkbrush.config.ts → inbox.dir)');
      const { path } = await readBody<{ path?: string }>(req);
      if (!path) return fail(res, 400, 'missing path');
      const abs = resolve(dir, path);
      // `+ sep` matters: a bare prefix test also accepts sibling directories
      // like /vault/inbox-evil for an inbox of /vault/inbox (same as snapshot.ts)
      if (!abs.startsWith(resolve(dir) + sep)) return fail(res, 400, 'path must be inside the inbox directory');
      if (!existsSync(abs)) return fail(res, 404, `file does not exist: ${abs}`);
      if (!isInboxNote(abs)) return fail(res, 400, 'not an importable note file');
      const result = importNote(abs, { force: true });
      json(res, 200, { ok: true, slug: result?.slug, warnings: result?.warnings ?? [] });
    },
    { auth: true },
  );
}
