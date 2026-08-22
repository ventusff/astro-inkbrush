/**
 * Note source access: id → file resolution, line-range block read/patch with
 * optimistic locking, whole-file MDX compile validation before any write, and
 * the append-only revisions journal (.wiki/data/revisions.ndjson).
 *
 * Edit history is two complementary layers (user decision): the journal =
 * fine-grained per-block audit log; git in the CONTENT repo = durable
 * versioning/backup. inkbrush.config.ts `autocommit` makes a git commit per save
 * (author = the logged-in user), `autopush` pushes asynchronously after each.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { scanNotes } from '../../lib/wikilinks';
import { wikiConfig } from './config';
import type { LocaleDef } from '../shared/locales';
import type { BlockSource, NoteLocale, NoteMeta, RevisionRecord } from '../shared/types';
import type { RouteRegistrar } from './index';
import { fail, json, readBody } from './index';
import { renderMarkdown } from './markdown';
import { appendNdjson, projectRoot, readNdjson, wikiDataDir } from './store';

const execFileP = promisify(execFile);

/* ---------------- id ↔ file ---------------- */

/** note content directory (relative to the site root) — inkbrush.config.ts → content.dir */
function notesBase(): string {
  return wikiConfig().content.dir;
}

/** resolve a note id ("guides/getting-started", "en/getting-started", "inbox/…") to its source file */
export function noteFile(id: string): { file: string; rel: string } | null {
  if (!/^[\w][\w.\-一-鿿/]*$/.test(id) || id.includes('..')) return null;
  for (const ext of ['mdx', 'md']) {
    const rel = `${notesBase()}/${id}/index.${ext}`;
    const file = resolve(projectRoot(), rel);
    if (!file.startsWith(resolve(projectRoot(), notesBase()))) return null;
    if (existsSync(file)) return { file, rel };
  }
  return null;
}

function frontmatterField(source: string, field: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!fm) return null;
  const line = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(fm[1]!);
  if (!line) return null;
  return line[1]!.trim().replace(/^['"]|['"]$/g, '');
}

/** the deployment's locale table — inkbrush.config.ts → content.locales
 *  (default table in shared/locales.ts) */
function noteLocales(): readonly LocaleDef[] {
  return wikiConfig().content.locales;
}

/** the locale whose notes live unprefixed (exactly one, enforced at resolve time) */
function defaultLocale(): LocaleDef {
  return noteLocales().find((l) => l.prefix === '')!;
}

export function localeOfId(id: string): NoteLocale {
  for (const l of noteLocales()) {
    if (l.prefix && (id === l.prefix.slice(0, -1) || id.startsWith(l.prefix))) return l.code;
  }
  return defaultLocale().code;
}

/** strip the language prefix: "en/getting-started" → "getting-started" */
export function baseIdOf(id: string): string {
  const loc = noteLocales().find((l) => l.code === localeOfId(id))!;
  return loc.prefix ? id.slice(loc.prefix.length) : id;
}

export function noteMeta(id: string): NoteMeta | null {
  const located = noteFile(id);
  if (!located) return null;
  const source = readFileSync(located.file, 'utf8');
  const lang = localeOfId(id);
  const base = baseIdOf(id);
  const demos = [...source.matchAll(/demo=["']([^"']+)["']/g)].map((m) => m[1]!);
  const locales = noteLocales().map((l) => {
    const lid = `${l.prefix}${base}`;
    return {
      code: l.code,
      id: lid,
      label: l.label,
      exists: Boolean(noteFile(lid)),
      current: l.code === lang,
    };
  });
  return {
    id,
    file: located.rel,
    title: frontmatterField(source, 'title') ?? id,
    lang,
    locales,
    demos: [...new Set(demos)],
  };
}

/* ---------------- block read / patch ---------------- */

export function sliceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readBlock(file: string, start: number, end: number): BlockSource | null {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (start < 1 || end < start || end > lines.length) return null;
  const source = lines.slice(start - 1, end).join('\n');
  return { source, hash: sliceHash(source), start, end };
}

/**
 * Compile the whole MDX file the way the site will (same dialect, same content
 * guard) — returns an error message or null. A block that passes here
 * renders on the page; one that would break the build is refused at save time.
 */
export async function validateMdx(source: string): Promise<string | null> {
  const [{ compile }, remarkMath, { markdownSyntax }, { remarkContentGuard }] =
    await Promise.all([
      import('@mdx-js/mdx'),
      import('remark-math').then((m) => m.default),
      import('../../lib/markdown-syntax'),
      import('../../lib/content-guard'),
    ]);
  // strip frontmatter the way Astro does before MDX sees the file
  const body = source.replace(/^---\n[\s\S]*?\n---/, (m) => m.replace(/[^\n]+/g, ''));
  try {
    await compile(body, {
      remarkPlugins: [...markdownSyntax(), remarkContentGuard, remarkMath],
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function journalRevision(record: RevisionRecord): void {
  appendNdjson(join(wikiDataDir(), 'revisions.ndjson'), record);
}

/**
 * Per-save git commit (+ optional async push), executed INSIDE the content
 * repo: src/content/notes is its own repo (submodule), so committing these
 * paths from the project root fails with "Pathspec … is in submodule".
 * Accepts project-relative files or directories; commits only those paths,
 * silently skipping when nothing actually changed (e.g. a no-op claude job).
 */
export async function autocommit(
  relPaths: string | string[],
  message: string,
  user: string,
): Promise<void> {
  const cfg = wikiConfig();
  if (!cfg.autocommit) return;
  const contentRoot = resolve(projectRoot(), notesBase());
  const rels: string[] = [];
  for (const p of Array.isArray(relPaths) ? relPaths : [relPaths]) {
    const rel = relative(contentRoot, resolve(projectRoot(), p));
    if (rel.startsWith('..')) {
      console.error(`[wiki autocommit] path is outside the content repo, skipping: ${p}`);
      continue;
    }
    rels.push(rel);
  }
  if (rels.length === 0) return;
  try {
    await execFileP('git', ['add', '-A', '--', ...rels], { cwd: contentRoot });
    const { stdout } = await execFileP('git', ['status', '--porcelain', '--', ...rels], {
      cwd: contentRoot,
    });
    if (!stdout.trim()) return; // nothing changed — no empty commit
    await execFileP(
      'git',
      ['commit', '-m', message, '--author', `${user} <wiki@local>`, '--', ...rels],
      { cwd: contentRoot },
    );
  } catch (err) {
    console.error('[wiki autocommit]', err);
    return;
  }
  if (cfg.autopush) {
    // fire-and-forget: the save must not wait on (or fail with) the network
    execFileP('git', ['push'], { cwd: contentRoot }).catch((err: unknown) => {
      console.error('[wiki autopush]', err);
    });
  }
}

/* ---------------- routes ---------------- */

export function registerSourceRoutes(on: RouteRegistrar): void {
  on('GET', '/meta/*id', ({ res, params }) => {
    const meta = noteMeta(params['id']!);
    if (!meta) return fail(res, 404, `Note not found: ${params['id']}`);
    json(res, 200, meta);
  });

  // reading source is editor-only (anonymous readers only see rendered pages)
  on(
    'GET',
    '/block/*id',
    ({ res, params, query }) => {
      const located = noteFile(params['id']!);
      if (!located) return fail(res, 404, 'Note not found');
      const start = Number(query.get('start'));
      const end = Number(query.get('end'));
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return fail(res, 400, 'start/end must be integer line numbers');
      }
      const block = readBlock(located.file, start, end);
      if (!block) return fail(res, 416, 'line range outside the file');
      json(res, 200, block);
    },
    { auth: true },
  );

  on(
    'PUT',
    '/block/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      const located = noteFile(id);
      if (!located) return fail(res, 404, 'Note not found');
      const body = await readBody<{ start: number; end: number; hash: string; source: string }>(req);
      const { start, end, hash, source } = body;
      if (!Number.isInteger(start) || !Number.isInteger(end) || typeof source !== 'string') {
        return fail(res, 400, 'missing start/end/source');
      }
      const current = readBlock(located.file, start, end);
      if (!current) return fail(res, 416, 'line range outside the file');
      if (current.hash !== hash) {
        return fail(res, 409, 'This block was modified by someone else — refresh and retry');
      }
      const lines = readFileSync(located.file, 'utf8').split('\n');
      const next = [...lines.slice(0, start - 1), ...source.split('\n'), ...lines.slice(end)].join(
        '\n',
      );
      if (located.file.endsWith('.mdx')) {
        const error = await validateMdx(next);
        if (error) return fail(res, 422, `MDX syntax error — not saved: ${error}`);
      }
      writeFileSync(located.file, next);
      journalRevision({
        ts: Date.now(),
        user: user!.email,
        note: id,
        lines: `${start}-${end}`,
        via: 'manual',
        before: current.source,
        after: source,
      });
      await autocommit(located.rel, `wiki: ${id} L${start}-${end} manual edit`, user!.name);
      json(res, 200, { ok: true });
    },
    { auth: true },
  );

  // the render oracle only serves the editing surface (preview / chat panel,
  // both behind login). sanitize defaults to TRUE — callers that want raw
  // HTML must say so explicitly (e.g. the editor previewing trusted repo content)
  on(
    'POST',
    '/render',
    async ({ req, res }) => {
      const { markdown, sanitize, note } = await readBody<{
        markdown?: string;
        sanitize?: boolean;
        note?: string;
      }>(req);
      if (typeof markdown !== 'string') return fail(res, 400, 'missing markdown');
      json(res, 200, {
        html: await renderMarkdown(markdown, {
          sanitize: sanitize ?? true,
          ...(typeof note === 'string' ? { note } : {}),
        }),
      });
    },
    { auth: true },
  );

  // lightweight note list for [[ autocomplete / wikilink resolution
  // (inbox included — everything is linkable)
  on('GET', '/notes', ({ res }) => {
    const dir = resolve(projectRoot(), notesBase());
    json(res, 200, { notes: scanNotes(dir) });
  });

  // revision history (with full before/after source) is editor-only
  on(
    'GET',
    '/revisions/*id',
    ({ res, params }) => {
      const all = readNdjson<RevisionRecord>(join(wikiDataDir(), 'revisions.ndjson'));
      json(res, 200, { revisions: all.filter((r) => r.note === params['id']).slice(-100) });
    },
    { auth: true },
  );

  // one-click revert of a journaled revision: exact-match replace of the
  // revision's `after` span with its `before`. Content drifted since then
  // (no exact match / ambiguous match) → 409, edit by hand instead.
  on(
    'POST',
    '/revert/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      const located = noteFile(id);
      if (!located) return fail(res, 404, 'Note not found');
      const { ts } = await readBody<{ ts?: number }>(req);
      if (!Number.isFinite(ts)) return fail(res, 400, 'missing ts');
      const all = readNdjson<RevisionRecord>(join(wikiDataDir(), 'revisions.ndjson'));
      const rec = all.find((r) => r.note === id && r.ts === ts);
      if (!rec) return fail(res, 404, 'Revision record not found');
      if (rec.lines === '*') return fail(res, 400, 'Whole-file operations cannot be reverted in one click');
      if (rec.before === rec.after) return fail(res, 400, 'This revision has no content change');

      const fileLines = readFileSync(located.file, 'utf8').split('\n');
      const target = rec.after.split('\n');
      const matches: number[] = [];
      for (let i = 0; i + target.length <= fileLines.length; i++) {
        let same = true;
        for (let j = 0; j < target.length; j++) {
          if (fileLines[i + j] !== target[j]) {
            same = false;
            break;
          }
        }
        if (same) matches.push(i);
      }
      if (matches.length === 0) {
        return fail(res, 409, 'Later edits overwrote this revision — revert by hand instead');
      }
      if (matches.length > 1) {
        return fail(res, 409, 'The target content appears more than once — revert by hand instead');
      }
      const at = matches[0]!;
      const beforeLines = rec.before.split('\n');
      const next = [
        ...fileLines.slice(0, at),
        ...beforeLines,
        ...fileLines.slice(at + target.length),
      ].join('\n');
      if (located.file.endsWith('.mdx')) {
        const error = await validateMdx(next);
        if (error) return fail(res, 422, `MDX would not compile after the revert — not applied: ${error}`);
      }
      writeFileSync(located.file, next);
      journalRevision({
        ts: Date.now(),
        user: user!.email,
        note: id,
        lines: `${at + 1}-${at + beforeLines.length}`,
        via: 'revert',
        before: rec.after,
        after: rec.before,
      });
      await autocommit(
        located.rel,
        `wiki: ${id} revert ${rec.via} revision @${new Date(rec.ts).toISOString()}`,
        user!.name,
      );
      json(res, 200, { ok: true });
    },
    { auth: true },
  );
}
