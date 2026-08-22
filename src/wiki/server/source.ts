/**
 * Note source access: id → file resolution inside the content root, line-range
 * block read/patch with optimistic locking, whole-file validation before any
 * write, and the append-only revisions journal (.wiki/data/revisions.ndjson).
 *
 * Write contract: every write of a note runs under the file's lock, re-reads
 * the file, re-checks the block hash against the current bytes, validates the
 * whole resulting file the way the site builds it (the dialect, the content
 * guard, the site's own remark plugins; MDX files are compiled) and replaces
 * the file atomically. A failed validation writes nothing.
 *
 * Edit history is two layers: the journal is the fine-grained per-block
 * audit log (each record has a unique id); git in the content repo is the
 * durable versioning — `autocommit` commits each save with the signed-in
 * user as author, `autopush` pushes asynchronously after each commit.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { LocaleDef } from '../shared/locales.ts';
import type { BlockSource, NoteLocale, NoteMeta, RevisionRecord } from '../shared/types.ts';
import { cachedScan } from '../../lib/wikilinks.ts';
import { wikiConfig } from './config.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, HttpError, json, readBody } from './index.ts';
import { renderMarkdown } from './markdown.ts';
import { frontmatterField, NOTE_ID } from './note-id.ts';
import { containedPath } from './paths.ts';
import { appendNdjson, projectRoot, readNdjson, wikiDataDir, withLock, writeFileAtomic } from './store.ts';
import { validateSource } from './validate.ts';

export { validateSource };

const execFileP = promisify(execFile);

/* ---------------- id ↔ file ---------------- */

/** note content directory (relative to the site root) — inkbrush.config.ts → content.dir */
function notesBase(): string {
  return wikiConfig().content.dir;
}

/** absolute content root */
export function contentRoot(): string {
  return resolve(projectRoot(), notesBase());
}

/** resolve a note id ("guides/getting-started", "en/getting-started", "inbox/…")
 *  to its source file inside the content root; null when absent or outside.
 *  A note with both index.md and index.mdx is a collision (the scanner
 *  refuses it too) and answers 404 naming it. */
export function noteFile(id: string): { file: string; rel: string } | null {
  if (!NOTE_ID.test(id)) return null;
  const located: Array<{ file: string; rel: string }> = [];
  for (const ext of ['mdx', 'md']) {
    const rel = `${notesBase()}/${id}/index.${ext}`;
    const file = containedPath(contentRoot(), resolve(projectRoot(), rel));
    if (file && existsSync(file)) located.push({ file, rel });
  }
  if (located.length > 1) {
    throw new HttpError(404, `Note '${id}' has both index.md and index.mdx — remove one of them`);
  }
  return located[0] ?? null;
}

/** the directory a new note would live in, inside the content root; null when outside */
export function noteDir(id: string): string | null {
  if (!NOTE_ID.test(id)) return null;
  return containedPath(contentRoot(), resolve(projectRoot(), notesBase(), id));
}

/** the deployment's locale table — inkbrush.config.ts → content.locales */
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

/* ---------------- revisions ---------------- */

const revisionsFile = (): string => join(wikiDataDir(), 'revisions.ndjson');

export function journalRevision(record: Omit<RevisionRecord, 'id'>): RevisionRecord {
  const full: RevisionRecord = { id: randomUUID(), ...record };
  appendNdjson(revisionsFile(), full);
  return full;
}

/**
 * Replace the file's content under its lock: `produce` computes the next
 * content from the file as it is at write time (and refuses with an error
 * when a block no longer matches, → 409), the result is validated (→ 422
 * when it would not build), then written atomically. `afterWrite` runs
 * inside the same lock after the write (journaling belongs there, so the
 * journal order matches the write order).
 */
export async function writeNote(
  file: string,
  produce: (current: string) => { next: string; error?: string | undefined },
  afterWrite?: (next: string) => void,
): Promise<void> {
  await withLock(file, async () => {
    const current = readFileSync(file, 'utf8');
    const { next, error } = produce(current);
    if (error) throw new HttpError(409, error);
    const problem = await validateSource(file, next);
    if (problem) throw new HttpError(422, `The note would not build — not saved: ${problem}`);
    writeFileAtomic(file, next);
    afterWrite?.(next);
  });
}

export type AutocommitResult = 'off' | 'clean' | 'committed' | 'failed';

// git operations run one at a time behind this queue, so concurrent saves
// cannot interleave their add/status/commit sequences
let gitChain: Promise<unknown> = Promise.resolve();

/**
 * Per-save git commit (+ optional async push) of the given project-relative
 * files or directories, executed from the content repo's own top level (so
 * paths outside content.dir but inside the repo commit too). Returns the
 * outcome; 'failed' also covers a path that lies outside the repo and
 * therefore cannot be committed.
 */
export function autocommit(
  relPaths: string | string[],
  message: string,
  user: string,
): Promise<AutocommitResult> {
  const cfg = wikiConfig();
  if (!cfg.autocommit) return Promise.resolve('off');
  const run = async (): Promise<AutocommitResult> => {
    let repoRoot: string;
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: contentRoot() });
      repoRoot = stdout.trim();
    } catch (err) {
      console.error('[wiki autocommit] cannot locate the content repo:', err);
      return 'failed';
    }
    const rels: string[] = [];
    let outside = false;
    for (const p of Array.isArray(relPaths) ? relPaths : [relPaths]) {
      const rel = relative(repoRoot, resolve(projectRoot(), p));
      if (rel.startsWith('..') || isAbsolute(rel)) {
        console.error(`[wiki autocommit] path is outside the content repo, cannot commit: ${p}`);
        outside = true;
        continue;
      }
      rels.push(rel);
    }
    if (rels.length === 0) return outside ? 'failed' : 'clean';
    try {
      await execFileP('git', ['add', '-A', '--', ...rels], { cwd: repoRoot });
      const { stdout } = await execFileP('git', ['status', '--porcelain', '--', ...rels], { cwd: repoRoot });
      if (!stdout.trim()) return outside ? 'failed' : 'clean';
      await execFileP('git', ['commit', '-m', message, '--author', `${user} <wiki@local>`, '--', ...rels], {
        cwd: repoRoot,
      });
    } catch (err) {
      console.error('[wiki autocommit]', err);
      return 'failed';
    }
    if (cfg.autopush) {
      // the save never waits on the network
      execFileP('git', ['push'], { cwd: repoRoot }).catch((err: unknown) => {
        console.error('[wiki autopush]', err);
      });
    }
    return outside ? 'failed' : 'committed';
  };
  const chained = gitChain.then(run, run);
  gitChain = chained.catch(() => undefined);
  return chained;
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
      if (!Number.isInteger(start) || !Number.isInteger(end) || typeof source !== 'string' || typeof hash !== 'string') {
        return fail(res, 400, 'missing start/end/hash/source');
      }
      let before = '';
      await writeNote(
        located.file,
        (current) => {
          const lines = current.split('\n');
          if (start < 1 || end < start || end > lines.length) {
            return { next: current, error: 'line range outside the file' };
          }
          before = lines.slice(start - 1, end).join('\n');
          if (sliceHash(before) !== hash) {
            return { next: current, error: 'This block was modified by someone else — refresh and retry' };
          }
          return { next: [...lines.slice(0, start - 1), ...source.split('\n'), ...lines.slice(end)].join('\n') };
        },
        // journaled inside the file's lock, so journal order = write order
        () =>
          journalRevision({
            ts: Date.now(),
            user: user!.email,
            note: id,
            lines: `${start}-${end}`,
            via: 'manual',
            before,
            after: source,
          }),
      );
      const git = await autocommit(located.rel, `wiki: ${id} L${start}-${end} manual edit`, user!.name);
      json(res, 200, git === 'failed' ? { ok: true, git: 'failed' } : { ok: true });
    },
    { auth: true },
  );

  // the render oracle serves the editing surface only (preview / chat panel,
  // both behind login). sanitize defaults to true — the editor previewing
  // trusted repo content says so explicitly
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

  // note list for [[ autocomplete / wikilink resolution (inbox included —
  // everything is linkable); the scan is cached for a short window
  const notes = cachedScan(contentRoot());
  on('GET', '/notes', ({ res }) => {
    json(res, 200, { notes: notes() });
  });

  // revision history (with full before/after source) is editor-only
  on(
    'GET',
    '/revisions/*id',
    ({ res, params }) => {
      const all = readNdjson<RevisionRecord>(revisionsFile());
      json(res, 200, { revisions: all.filter((r) => r.note === params['id']).slice(-100) });
    },
    { auth: true },
  );

  // one-click revert of a journaled block revision: exact-match replace of
  // the revision's `after` span with its `before`. The match must be
  // unambiguous: no match is a 409; several matches fall back to the one
  // overlapping the recorded line span, and stay a 409 when none or more
  // than one does.
  on(
    'POST',
    '/revert/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      const located = noteFile(id);
      if (!located) return fail(res, 404, 'Note not found');
      const { id: revisionId } = await readBody<{ id?: string }>(req);
      if (typeof revisionId !== 'string' || !revisionId) return fail(res, 400, 'missing revision id');
      const rec = readNdjson<RevisionRecord>(revisionsFile()).find((r) => r.note === id && r.id === revisionId);
      if (!rec) return fail(res, 404, 'Revision record not found');
      if (rec.lines === '*') return fail(res, 400, 'Whole-file operations cannot be reverted in one click');
      if (rec.before === rec.after) return fail(res, 400, 'This revision has no content change');

      let at = -1;
      const beforeLines = rec.before.split('\n');
      await writeNote(
        located.file,
        (current) => {
          const fileLines = current.split('\n');
          const target = rec.after.split('\n');
          const matches: number[] = [];
          for (let i = 0; i + target.length <= fileLines.length; i++) {
            if (target.every((line, j) => fileLines[i + j] === line)) matches.push(i);
          }
          if (matches.length === 0) {
            return { next: current, error: 'Later edits overwrote this revision — revert by hand instead' };
          }
          let chosen = matches;
          if (matches.length > 1) {
            // several matches: only the one overlapping the recorded line
            // span is unambiguous (match at index i covers lines i+1..i+len)
            const span = /^(\d+)-(\d+)$/.exec(rec.lines);
            chosen = span
              ? matches.filter((i) => i + 1 <= Number(span[2]) && i + target.length >= Number(span[1]))
              : [];
          }
          if (chosen.length !== 1) {
            return { next: current, error: 'The target content appears more than once — revert by hand instead' };
          }
          at = chosen[0]!;
          return {
            next: [...fileLines.slice(0, at), ...beforeLines, ...fileLines.slice(at + target.length)].join('\n'),
          };
        },
        // journaled inside the file's lock, so journal order = write order
        () =>
          journalRevision({
            ts: Date.now(),
            user: user!.email,
            note: id,
            lines: `${at + 1}-${at + beforeLines.length}`,
            via: 'revert',
            before: rec.after,
            after: rec.before,
          }),
      );
      const git = await autocommit(
        located.rel,
        `wiki: ${id} revert ${rec.via} revision ${rec.id}`,
        user!.name,
      );
      json(res, 200, git === 'failed' ? { ok: true, git: 'failed' } : { ok: true });
    },
    { auth: true },
  );
}
