/**
 * Obsidian inbox sync — optional per deployment: watches the vault folder
 * configured in inkbrush.config.ts → inbox.dir (env override WIKI_INBOX_DIR)
 * and converts every new note into a site article under
 * <content.dir>/inbox/<slug>/index.md. No dir configured = the watcher never
 * starts and the import endpoint refuses.
 *
 *  - Plain .md output (not .mdx), so prose is never parsed as JSX.
 *  - Every syntax conversion applies to prose only (the maskNonProse view):
 *    a spelling inside fenced/inline code, HTML or math stays literal.
 *  - `![[img|alt]]` embeds: the asset is copied from the vault (the note's
 *    `_assets/<note>/`, `_assets/` or own folder — never from outside those)
 *    into the note's directory and rewritten to a relative image reference
 *    (`./file`), which the site's Markdown pipeline resolves beside the
 *    note. When two different source files claim one basename, the later
 *    copy carries a content-hash suffix instead of overwriting.
 *  - `[[wikilink]]` and `[[note#anchor|label]]` are parsed by the shared
 *    extractor: a target that resolves to a site note stays a wikilink, any
 *    other is flattened to italics with a warning.
 *  - `==x==` → <mark>; single-line `$$x$$` display math normalized to the
 *    three-line form.
 *  - Obsidian frontmatter (author/source/url/saved) becomes a "Source" quote
 *    block at the top of the article.
 *  - `inbox.ignore` (config) skips files by vault-relative path or basename
 *    prefix.
 *
 * Import safety: the conversion stages its assets in a temp directory and
 * builds the note source in memory — nothing touches the content tree yet.
 * The result must pass the same validateSource gate a manual save passes.
 * Publication happens under the note file's write lock (the key manual
 * saves hold): the current content is read as the journal's true `before`,
 * a slug whose note no longer matches the last import's output is refused
 * (a manual edit always wins), assets land before the note, each file
 * moved into place atomically. The revision is journaled whole-file
 * (lines '*') with the real before/after, and the git autocommit is
 * awaited on the same path manual saves use — a failed commit is reported
 * with the file named. A failed conversion or validation leaves no partial
 * files anywhere.
 *
 * Files that exist when the watcher starts are marked as seen and not
 * imported; POST /api/wiki/inbox/import {path} imports a specific file.
 * State lives in .wiki/data/inbox-sync.json (content hash → re-import on
 * change, same slug); every read-modify-write of it holds its lock. Paths
 * are compared segment-wise (src/lib/path-segments.ts), so the filters and
 * state keys hold on Windows separators too.
 */
import { watch, type FSWatcher } from 'chokidar';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { hasPathSegment, toPosixPath } from '../../lib/path-segments.ts';
import { buildWikilinkResolver, cachedScan, extractWikilinks, maskNonProse, type MaskOptions } from '../../lib/wikilinks.ts';
import { wikiConfig } from './config.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, HttpError, json, readBody } from './index.ts';
import { containedPath, isWithin, vaultPathCandidates } from './paths.ts';
import { noteUrl } from './site.ts';
import { autocommit, contentRoot, journalRevision, validateSource } from './source.ts';
import { projectRoot, readJson, wikiDataDir, withLock, writeFileAtomic, writeJson } from './store.ts';

/** configured watch dir (absolute, ~ expanded) — null = inbox sync disabled */
export function inboxDir(): string | null {
  return wikiConfig().inbox.dir;
}

/* ---------------- sync state ---------------- */

interface SyncState {
  [relPath: string]: {
    slug: string;
    /** content hash of the vault source at last import */
    hash: string;
    /** content hash of the note the importer published — the re-import
     *  baseline: a published note that no longer matches was edited by
     *  hand and is never overwritten (absent on records from before this
     *  field existed; such notes also refuse re-import until reconciled) */
    noteHash?: string;
    importedAt: number | null;
  };
}

function stateFile(): string {
  return join(wikiDataDir(), 'inbox-sync.json');
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** the state key of a vault file: its vault-relative path, `/`-spelled */
function stateKey(dir: string, sourcePath: string): string {
  return toPosixPath(relative(dir, resolve(sourcePath)));
}

/* ---------------- obsidian → site markdown ---------------- */

interface ObsidianFrontmatter {
  author?: string;
  source?: string;
  url?: string;
  saved?: string;
}

/** a frontmatter value as a display string: a scalar, or a one-item list's
 *  scalar (clippers wrap authors in lists); anything else is absent */
function fmString(value: unknown): string | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar === 'string') return scalar;
  if (typeof scalar === 'number' || typeof scalar === 'boolean') return String(scalar);
  return undefined;
}

/**
 * Vault-note frontmatter via the shared splitter — real YAML, so multiline
 * values, lists and quoting all read correctly. Tolerant by design: a file
 * with broken YAML still imports, with minimal metadata ({}) and the block
 * blanked out of the body, rather than failing the import. Clipped pages
 * often carry entity-encoded values; the common entities are decoded.
 */
function parseObsidianNote(raw: string): { fm: ObsidianFrontmatter; body: string } {
  const split = splitFrontmatter(raw);
  const fm: ObsidianFrontmatter = {};
  for (const key of ['author', 'source', 'url', 'saved'] as const) {
    const value = fmString(split.data[key]);
    if (value === undefined) continue;
    fm[key] = value
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return { fm, body: split.body };
}

/** derive the import date: parent folder "YYYY-MM-DD" → frontmatter saved → today */
function noteDate(sourcePath: string, fm: ObsidianFrontmatter): string {
  const dir = basename(dirname(sourcePath));
  if (/^\d{4}-\d{2}-\d{2}$/.test(dir)) return dir;
  const saved = /^(\d{4}-\d{2}-\d{2})/.exec(fm.saved ?? '');
  if (saved) return saved[1]!;
  return new Date().toISOString().slice(0, 10);
}

/** the note's vault-relative path with forward slashes (the basename when
 *  the file is outside the configured vault) */
function vaultRelPath(sourcePath: string): string {
  const dir = inboxDir();
  const abs = resolve(sourcePath);
  return dir !== null && isWithin(dir, abs) ? toPosixPath(relative(dir, abs)) : basename(abs);
}

/** the slug of a NEW import: date + a hash of the vault-relative path, so
 *  same-named notes in different vault folders cannot collide. A note that
 *  is already in the sync state keeps its recorded slug across re-imports
 *  (importNote passes it in); this rule fires for first imports only. */
function slugFor(sourcePath: string, fm: ObsidianFrontmatter): string {
  const hash = createHash('sha256').update(vaultRelPath(sourcePath)).digest('hex').slice(0, 8);
  return `${noteDate(sourcePath, fm)}-${hash}`;
}

/**
 * A regex conversion applied only where the source is prose: matches are
 * located in the maskNonProse view (frontmatter, code, HTML, links and —
 * unless `mask.keepMath` — math are blanked at equal length), and a match
 * is rewritten only when the source spells it identically, so a match
 * straddling a masked range is left untouched.
 */
function replaceInProse(
  source: string,
  re: RegExp,
  replacer: (...groups: (string | undefined)[]) => string,
  mask: MaskOptions = {},
): string {
  const masked = maskNonProse(source, mask);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0]!.length;
    if (source.slice(start, end) !== m[0]) continue;
    out += source.slice(last, start) + replacer(...(m as (string | undefined)[]));
    last = end;
  }
  return out + source.slice(last);
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

/** what a conversion produces — everything still in memory or in the stage
 *  directory, nothing in the content tree */
interface StagedNote {
  slug: string;
  /** the full index.md source */
  source: string;
  /** asset file names, staged flat inside the stage directory */
  assets: string[];
  warnings: string[];
}

/** the outcome of a published import */
export interface ConvertResult {
  slug: string;
  /** the published note directory (absolute) */
  noteDir: string;
  assetsCopied: number;
  warnings: string[];
}

/**
 * Convert one vault note. Assets are copied into `stageDir` (which must
 * exist) under their final names; the note source is returned, not
 * written — publication is importNote's job.
 */
export function convertObsidianNote(sourcePath: string, opts: { stageDir: string; slug?: string }): StagedNote {
  const raw = readFileSync(sourcePath, 'utf8');
  const { fm, body } = parseObsidianNote(raw);
  const title = basename(sourcePath).replace(/\.md$/, '');
  const slug = opts.slug ?? slugFor(sourcePath, fm);
  const warnings: string[] = [];

  /** obsidian keeps embeds in `<note dir>/_assets/<note name>/`; a name
   *  only ever resolves to a file inside one of these roots */
  const assetRoots = [
    join(dirname(sourcePath), '_assets', title),
    join(dirname(sourcePath), '_assets'),
    dirname(sourcePath),
  ];
  const resolveAsset = (name: string): string | null => {
    for (const root of assetRoots) {
      const candidate = containedPath(root, name);
      if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    for (const candidate of vaultPathCandidates(inboxDir(), name)) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };

  /** stage an asset under a collision-safe name: the first source file to
   *  claim a basename keeps it; a different source file claiming a taken
   *  name gets a content-hash suffix, and one source file referenced twice
   *  is copied once */
  const copiedNames = new Map<string, string>(); // source path → output name
  const takenNames = new Set<string>();
  const copyAsset = (found: string): string => {
    const prior = copiedNames.get(found);
    if (prior !== undefined) return prior;
    let name = basename(found);
    if (takenNames.has(name)) {
      const hash = createHash('sha256').update(readFileSync(found)).digest('hex').slice(0, 8);
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)}-${hash}${name.slice(dot)}` : `${name}-${hash}`;
    }
    takenNames.add(name);
    copiedNames.set(found, name);
    copyFileSync(found, join(opts.stageDir, name));
    return name;
  };

  let markdown = body;

  // ![[file|alt]] image/file embeds (prose only — a spelling inside code
  // stays literal) → stage asset + standard image syntax
  markdown = replaceInProse(markdown, /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, file, alt) => {
    const found = resolveAsset(file!.trim());
    if (!found) {
      warnings.push(`embedded asset not found: ${file}`);
      // the surrounding spaces matter: two adjacent embeds would fuse into
      // `]**[`, and CommonMark's rule-of-three refuses to pair those markers,
      // leaking literal asterisks into the prose.
      return ` *[missing attachment: ${file!.trim()}]* `;
    }
    return `![${alt?.trim() ?? ''}](./${encodeURIComponent(copyAsset(found))})`;
  });

  // [[wikilinks]] (anchors and labels included, code spans excluded — the
  // shared extractor): a target that resolves to a site note stays a
  // wikilink; any other is flattened to italics with a warning
  const resolveWikilink = buildWikilinkResolver({
    notes: cachedScan(contentRoot()),
    urlFor: noteUrl,
    locales: wikiConfig().content.locales.map((l) => ({ code: l.code, prefix: l.prefix })),
  });
  for (const link of extractWikilinks(markdown).reverse()) {
    const res = resolveWikilink(link.target);
    let replacement: string;
    if (res.kind === 'ok') {
      const anchor = link.anchor ? `#${link.anchor}` : '';
      const shown = link.label && link.label !== res.id ? `|${link.label}` : '';
      replacement = `[[${res.id}${anchor}${shown}]]`;
    } else {
      warnings.push(`unresolved wikilink: ${link.target}`);
      replacement = `*${link.label ?? link.target}*`;
    }
    markdown = markdown.slice(0, link.offset) + replacement + markdown.slice(link.offset + link.raw.length);
  }

  // ==highlight== → <mark> (prose only)
  markdown = replaceInProse(markdown, /==([^=\n][^=\n]*)==/g, (_, text) => `<mark>${text}</mark>`);

  // single-line display math → three-line form (remark-math would inline
  // it); keepMath keeps the `$$…$$` span visible in the mask while code and
  // HTML stay blanked
  markdown = replaceInProse(
    markdown,
    /^\$\$(.+?)\$\$[^\S\n]*$/gm,
    (_, tex) => `$$\n${tex!.trim()}\n$$`,
    { keepMath: true },
  );

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

  return {
    slug,
    source: `${frontmatter}\n\n${attribution}${markdown.trim()}\n`,
    assets: [...copiedNames.values()],
    warnings,
  };
}

/* ---------------- import orchestration ---------------- */

function isInboxNote(path: string): boolean {
  if (!path.endsWith('.md')) return false;
  if (hasPathSegment(path, '_assets')) return false;
  // config-driven skip list (inkbrush.config.ts → inbox.ignore): each entry
  // is a prefix of the vault-relative path or of the basename
  const dir = inboxDir();
  const rel = dir ? stateKey(dir, path) : basename(path);
  const name = basename(path);
  for (const entry of wikiConfig().inbox.ignore) {
    if (rel.startsWith(entry) || name.startsWith(entry)) return false;
  }
  return true;
}

/** move `src` into place: a sibling temp copy renamed over `dest`, so a
 *  reader sees the old file or the new one, never a torn copy */
function publishFile(src: string, dest: string): void {
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp copy never created or already gone */
    }
    throw err;
  }
}

export async function importNote(sourcePath: string, opts?: { force?: boolean }): Promise<ConvertResult | null> {
  const dir = inboxDir();
  if (!dir) throw new Error('Inbox is not enabled (inkbrush.config.ts → inbox.dir)');
  const abs = resolve(sourcePath);
  if (!isWithin(dir, abs)) throw new Error('note is outside the inbox directory');
  const rel = stateKey(dir, abs);
  const raw = readFileSync(abs, 'utf8');
  const hash = contentHash(raw);
  const result = await withLock(stateFile(), async () => {
    const state = readJson<SyncState>(stateFile(), {});
    const existing = state[rel];
    if (!opts?.force && existing?.hash === hash && existing.importedAt !== null) return null;
    // the conversion stages into a temp directory; a failure below leaves
    // nothing behind but this directory, removed on every path
    const stage = mkdtempSync(join(tmpdir(), 'inkbrush-inbox-'));
    try {
      // a re-import keeps the slug the state recorded at first import, so
      // the note id (and its URL) never changes under a slug-rule change
      const staged = convertObsidianNote(abs, {
        stageDir: stage,
        ...(existing?.slug ? { slug: existing.slug } : {}),
      });
      const noteDir = join(contentRoot(), 'inbox', staged.slug);
      const noteRel = relative(projectRoot(), join(noteDir, 'index.md'));
      // the same gate a manual save passes: a note that would not build is
      // refused before anything reaches the content tree
      const problem = await validateSource(noteRel, staged.source);
      if (problem) throw new Error(`converted note would not build — not imported: ${problem}`);

      // publish under the note file's write lock — the key manual saves
      // hold — so an in-flight manual edit and this import serialize
      const lockKey = containedPath(contentRoot(), join('inbox', staged.slug, 'index.md')) ?? join(noteDir, 'index.md');
      await withLock(lockKey, () => {
        const current = existsSync(lockKey) ? readFileSync(lockKey, 'utf8') : null;
        if (current === staged.source) {
          // identical content: nothing to write or journal
        } else {
          if (current !== null && contentHash(current) !== existing?.noteHash) {
            // the note on disk is not what the importer published (a manual
            // edit, or a record predating the baseline): a manual edit
            // always wins — refuse, force included
            throw new HttpError(
              409,
              `refusing to overwrite ${noteRel}: it no longer matches the last import — reconcile or remove the note first`,
            );
          }
          mkdirSync(noteDir, { recursive: true });
          // assets land before the note: a reader never sees a note whose
          // assets are missing
          for (const name of staged.assets) publishFile(join(stage, name), join(noteDir, name));
          writeFileAtomic(join(noteDir, 'index.md'), staged.source);
          // whole-file journal record with the true before/after (creation:
          // before '', the server's convention for new files)
          journalRevision({
            ts: Date.now(),
            user: 'inbox-sync',
            note: `inbox/${staged.slug}`,
            lines: '*',
            via: 'inbox',
            before: current ?? '',
            after: staged.source,
          });
        }
      });
      state[rel] = { slug: staged.slug, hash, noteHash: contentHash(staged.source), importedAt: Date.now() };
      writeJson(stateFile(), state);
      return { staged, noteDir };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
  if (!result) return null;
  const { staged, noteDir } = result;
  const noteRelDir = relative(projectRoot(), noteDir);
  // the commit is awaited on the same git path manual saves use; a failure
  // names the uncommitted files
  const git = await autocommit(noteRelDir, `wiki: inbox/${staged.slug} Obsidian import`, 'inbox-sync');
  if (git === 'failed') {
    console.error(`[wiki inbox] git commit FAILED for ${noteRelDir} — the import is on disk but not committed`);
  }
  console.log(`[wiki inbox] imported "${rel}" → inbox/${staged.slug} (${staged.assets.length} assets)`);
  for (const warning of staged.warnings) console.warn(`[wiki inbox]   ⚠ ${warning}`);
  return { slug: staged.slug, noteDir, assetsCopied: staged.assets.length, warnings: staged.warnings };
}

/** mark a pre-existing file as seen without importing it */
function markSeen(dir: string, sourcePath: string): Promise<void> {
  const rel = stateKey(dir, sourcePath);
  return withLock(stateFile(), () => {
    const state = readJson<SyncState>(stateFile(), {});
    if (state[rel]) return;
    state[rel] = { slug: '', hash: contentHash(readFileSync(sourcePath, 'utf8')), importedAt: null };
    writeJson(stateFile(), state);
  });
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
    // _assets image trees only burns inotify watches. Segment comparison:
    // the watcher hands back native separators on Windows.
    ignored: (path) => hasPathSegment(path, '_assets'),
  });
  const report = (what: string, path: string) => (err: unknown): void => {
    console.error(`[wiki inbox] ${what} failed for ${path}:`, err);
  };
  watcher.on('add', (path) => {
    if (!isInboxNote(path)) return;
    if (!ready) markSeen(dir, path).catch(report('marking', path));
    else importNote(path).catch(report('import', path));
  });
  watcher.on('change', (path) => {
    if (!ready || !isInboxNote(path)) return;
    // only a note imported before is re-imported on change
    const state = readJson<SyncState>(stateFile(), {});
    if (state[stateKey(dir, path)]?.importedAt === null) return;
    importNote(path).catch(report('re-import', path));
  });
  watcher.on('ready', () => {
    ready = true;
    console.log(`[wiki inbox] watching ${dir}`);
  });
  globals[WATCHER_KEY] = watcher;
}

/* ---------------- routes ---------------- */

export function registerInboxRoutes(on: RouteRegistrar): void {
  on(
    'GET',
    '/inbox/status',
    ({ res }) => {
      const state = readJson<SyncState>(stateFile(), {});
      const entries = Object.entries(state);
      json(res, 200, {
        enabled: inboxDir() !== null,
        watching: Boolean((globalThis as Record<string, unknown>)[WATCHER_KEY]),
        seen: entries.length,
        imported: entries.filter(([, v]) => v.importedAt !== null).length,
      });
    },
    { auth: true },
  );

  on(
    'POST',
    '/inbox/import',
    async ({ req, res }) => {
      const dir = inboxDir();
      if (!dir) return fail(res, 400, 'Inbox is not enabled (inkbrush.config.ts → inbox.dir)');
      const { path } = await readBody<{ path?: string }>(req);
      if (!path) return fail(res, 400, 'missing path');
      const abs = containedPath(dir, path);
      if (!abs) return fail(res, 400, 'path must be inside the inbox directory');
      if (!existsSync(abs)) return fail(res, 404, `file does not exist: ${path}`);
      if (!isInboxNote(abs)) return fail(res, 400, 'not an importable note file');
      const result = await importNote(abs, { force: true });
      json(res, 200, { ok: true, slug: result?.slug, warnings: result?.warnings ?? [] });
    },
    { auth: true },
  );
}
