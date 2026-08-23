/**
 * Bridge to the claude CLI on the host machine.
 *
 * Every job is one `claude -p … --output-format stream-json` child process
 * (./claude-process.ts), its event stream mapped to the wiki's NDJSON
 * protocol (ClaudeStreamEvent) and piped to the browser over a chunked
 * response.
 *
 * Isolation: a job never runs in the project. It runs in a throwaway
 * workspace (./workspace.ts) that holds only the note's directory and the
 * companions the site's config names, its file tools are confined to that
 * directory by permission rules (Read/Edit/Write on `./**` only, no Bash, no
 * Grep/Glob, no network tools), its environment is allowlisted, and what it
 * changed is carried back into the project only after every changed note
 * passes the job's shape postcondition (./job-postconditions.ts) and
 * validates — under the file locks, against the workspace's creation
 * baseline — then journaled (every applied file) and autocommitted. A
 * failed job, an invalid result, a change outside the scope or a conflict
 * with a concurrent edit leaves the project untouched and is reported to
 * the browser as an error.
 *
 *  - block edit / translate: keep running server-side if the browser tab
 *    goes away; the result is applied when the job ends. The block source
 *    and the prompt derive from the file as it is when the job starts
 *    inside the per-note queue, not from the request.
 *  - ask: read-only, killed when the client disconnects; the session id is
 *    captured so the chat panel can `--resume` follow-ups, and a resume is
 *    accepted only from the session's own user on the session's own note.
 *
 * Jobs are serialized per note (in-memory queue). Capacity is capped per
 * user and globally; both slots are taken only when a job actually starts
 * executing — queued work holds no capacity — and released when it ends.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClaudeStreamEvent } from '../shared/types.ts';
import { runClaudeJob } from './claude-process.ts';
import { wikiConfig } from './config.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, ndjsonStream, readBody } from './index.ts';
import { blockEditViolation, revisionSpan, translateViolation } from './job-postconditions.ts';
import { askPrompt, blockEditPrompt, translatePrompt } from './prompts.ts';
import { autocommit, journalRevision, noteDir, noteFile, noteMeta, validateSource } from './source.ts';
import { createWorkspace, type Workspace, type WorkspaceChange } from './workspace.ts';

/* ---------------- capacity & session ownership ---------------- */

/** concurrent AI jobs one user may hold */
const MAX_JOBS_PER_USER = 2;
/** concurrent AI jobs the machine runs across all users */
const MAX_JOBS_GLOBAL = 4;

const userJobs = new Map<string, number>();
let globalJobs = 0;
let capacityWaiters: Array<() => void> = [];

/** the 429 message when `email` cannot start a job right now; null = capacity free */
function saturationError(email: string): string | null {
  if ((userJobs.get(email) ?? 0) >= MAX_JOBS_PER_USER) {
    return `You already have ${MAX_JOBS_PER_USER} AI jobs running — wait for one to finish`;
  }
  if (globalJobs >= MAX_JOBS_GLOBAL) {
    return `The machine is already running ${MAX_JOBS_GLOBAL} AI jobs — try again when one finishes`;
  }
  return null;
}

/**
 * Take one per-user and one global slot, waiting for capacity when a race
 * filled it between the route's 429 check and the job's start. Returns the
 * release function; releasing is idempotent.
 */
async function acquireSlots(email: string): Promise<() => void> {
  while (saturationError(email) !== null) {
    await new Promise<void>((resolve) => capacityWaiters.push(resolve));
  }
  userJobs.set(email, (userJobs.get(email) ?? 0) + 1);
  globalJobs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (userJobs.get(email) ?? 1) - 1;
    if (left <= 0) userJobs.delete(email);
    else userJobs.set(email, left);
    globalJobs -= 1;
    const waiters = capacityWaiters;
    capacityWaiters = [];
    for (const wake of waiters) wake();
  };
}

/** CLI session ids streamed to a user, each bound to its issuing user and
 *  note. In-memory only: a server restart forgets them, and a resume of a
 *  forgotten session is refused (the client starts a fresh session). */
const sessionOwners = new Map<string, { email: string; note: string }>();
const SESSION_OWNERS_MAX = 1000;

function rememberSession(sessionId: string, email: string, note: string): void {
  if (sessionOwners.size >= SESSION_OWNERS_MAX && !sessionOwners.has(sessionId)) {
    const oldest = sessionOwners.keys().next().value;
    if (oldest !== undefined) sessionOwners.delete(oldest);
  }
  sessionOwners.set(sessionId, { email, note });
}

/** the session may be resumed by this user on this note */
function sessionResumable(sessionId: string, email: string, note: string): boolean {
  const owner = sessionOwners.get(sessionId);
  return owner !== undefined && owner.email === email && owner.note === note;
}

/* ---------------- per-note job queue ---------------- */

const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(noteId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(noteId) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(noteId, next);
  // the entry is dropped once the queue drains
  next.then(
    () => {
      if (queues.get(noteId) === next) queues.delete(noteId);
    },
    () => {
      if (queues.get(noteId) === next) queues.delete(noteId);
    },
  );
  return next;
}

/* ---------------- scope, validation, journaling ---------------- */

/** project-relative paths an edit job may read and change for `noteId` */
function jobScope(noteId: string, extraDirs: string[] = []): string[] {
  const located = noteFile(noteId);
  const scope = new Set<string>(extraDirs);
  if (located) {
    scope.add(dirname(located.rel));
    const companions = wikiConfig().claude.companions;
    if (companions) {
      const source = readFileSync(located.file, 'utf8');
      for (const rel of companions({ id: noteId, file: located.rel, dir: dirname(located.rel), source })) {
        scope.add(rel.replace(/\/+$/, ''));
      }
    }
  }
  return [...scope];
}

/** every changed note must build; returns the first problem or null */
async function validateChanges(changes: WorkspaceChange[]): Promise<string | null> {
  for (const change of changes) {
    if (change.content === null || !/\.(md|mdx)$/.test(change.rel)) continue;
    const problem = await validateSource(change.rel, change.content);
    if (problem) return `${change.rel}: ${problem}`;
  }
  return null;
}

/**
 * Run an edit job in a workspace of `scope`, then check its postcondition,
 * validate, apply, journal and commit its changes. Every outcome is
 * reported on the stream: a conflict, containment or postcondition refusal
 * applies nothing, and a git failure is reported alongside the successful
 * save.
 */
async function runEditJob(opts: {
  noteId: string;
  scope: string[];
  prompt: string;
  timeoutMs: number;
  stream: { write: (e: ClaudeStreamEvent) => void };
  clientClosed: AbortSignal;
  user: { email: string; name: string };
  via: 'claude' | 'translate';
  commitMessage: string;
  /** the note the journal entries are about, and its project-relative file */
  journalNote: string;
  journalFile: string;
  /** note source files the job must not delete */
  protectedFiles: string[];
  /** per-job shape constraint on the changes (./job-postconditions.ts);
   *  a violation message refuses the whole application */
  postcondition?: (changes: WorkspaceChange[], baseline: (rel: string) => string | null) => string | null;
}): Promise<void> {
  const { stream } = opts;
  let ws: Workspace;
  try {
    ws = createWorkspace(opts.scope);
  } catch (err) {
    stream.write({ kind: 'error', message: `Could not prepare the workspace: ${(err as Error).message}` });
    return;
  }
  try {
    const { bin, model } = wikiConfig().claude;
    const result = await runClaudeJob({
      bin,
      model,
      prompt: opts.prompt,
      mode: 'edit',
      cwd: ws.dir,
      timeoutMs: opts.timeoutMs,
      killOnDisconnect: false,
      onEvent: (event) => {
        if ((event.kind === 'init' || event.kind === 'result') && event.sessionId) {
          rememberSession(event.sessionId, opts.user.email, opts.noteId);
        }
        stream.write(event);
      },
      clientClosed: opts.clientClosed,
    });
    if (!result.ok) {
      stream.write({ kind: 'error', message: `${result.error} — nothing was changed` });
      return;
    }
    const changes = ws.changes();
    if (changes.length === 0) {
      stream.write({ kind: 'result', ok: true, summary: result.summary || 'No change was needed.', sessionId: result.sessionId });
      return;
    }
    const deleted = changes.find((c) => c.content === null && opts.protectedFiles.includes(c.rel));
    if (deleted) {
      stream.write({
        kind: 'error',
        message: `The job deleted the note's own file (${deleted.rel}) — nothing was changed`,
      });
      return;
    }
    const violation = opts.postcondition?.(changes, (rel) => ws.baseline(rel)) ?? null;
    if (violation) {
      stream.write({ kind: 'error', message: `${violation} — nothing was changed` });
      return;
    }
    const problem = await validateChanges(changes);
    if (problem) {
      stream.write({ kind: 'error', message: `The result would not build — nothing was changed: ${problem}` });
      return;
    }
    try {
      await ws.apply(changes);
    } catch (err) {
      stream.write({ kind: 'error', message: (err as Error).message });
      return;
    }
    // every applied change is journaled: the note file with a baseline as a
    // revertible line-span diff; a new file, a whole-file rewrite and every
    // companion as an audit row (lines '*', which the one-click revert
    // refuses — reverting a file into emptiness is never one click)
    for (const change of changes) {
      const base = ws.baseline(change.rel);
      const span =
        change.rel === opts.journalFile && change.content !== null && base !== null
          ? revisionSpan(base, change.content)
          : null;
      if (span) {
        journalRevision({
          ts: Date.now(),
          user: opts.user.email,
          note: opts.journalNote,
          lines: span.lines,
          via: opts.via,
          before: span.before,
          after: span.after,
        });
      } else {
        journalRevision({
          ts: Date.now(),
          user: opts.user.email,
          note: opts.journalNote,
          ...(change.rel === opts.journalFile ? {} : { file: change.rel }),
          lines: '*',
          via: opts.via,
          before: base ?? '',
          after: change.content ?? '',
        });
      }
    }
    const git = await autocommit(
      changes.map((c) => c.rel),
      opts.commitMessage,
      opts.user.name,
    );
    const summary =
      git === 'failed'
        ? `${result.summary}\n\nSaved, but the git commit failed — check the server log.`
        : result.summary;
    stream.write({ kind: 'result', ok: true, summary, sessionId: result.sessionId });
  } finally {
    ws.destroy();
  }
}

/* ---------------- routes ---------------- */

export function registerClaudeRoutes(on: RouteRegistrar): void {
  on(
    'POST',
    '/claude/block',
    async ({ req, res, user }) => {
      const body = await readBody<{ id?: string; start?: number; end?: number; instruction?: string }>(req);
      const { id, start, end, instruction } = body;
      if (!id || !Number.isInteger(start) || !Number.isInteger(end) || !instruction?.trim()) {
        return fail(res, 400, 'missing id/start/end/instruction');
      }
      // request-time checks answer with clean HTTP statuses; the queued job
      // re-checks everything against the file as it is when it starts
      const located = noteFile(id);
      if (!noteMeta(id) || !located) return fail(res, 404, 'Note not found');
      const lineCount = readFileSync(located.file, 'utf8').split('\n').length;
      if (start! < 1 || end! < start! || end! > lineCount) return fail(res, 416, 'line range outside the file');
      const saturated = saturationError(user!.email);
      if (saturated) return fail(res, 429, saturated);
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      await enqueue(id, async () => {
        // the block source and the prompt derive from the file as it is
        // now: a save landing while this job sits in the queue is what the
        // job edits, never the request-time text
        let job: { rel: string; scope: string[]; prompt: string };
        try {
          const meta = noteMeta(id);
          const located2 = noteFile(id);
          if (!meta || !located2) {
            stream.write({ kind: 'error', message: 'Note not found — nothing was changed' });
            return;
          }
          const lines = readFileSync(located2.file, 'utf8').split('\n');
          if (start! < 1 || end! < start! || end! > lines.length) {
            stream.write({
              kind: 'error',
              message: 'The selected line range no longer exists (the note changed while the job was queued) — reload and retry',
            });
            return;
          }
          const source = lines.slice(start! - 1, end).join('\n');
          const scope = jobScope(id);
          job = {
            rel: located2.rel,
            scope,
            prompt: blockEditPrompt({
              meta,
              start: start!,
              end: end!,
              source,
              instruction: instruction!,
              companions: scope.filter((s) => s !== dirname(located2.rel)),
            }),
          };
        } catch (err) {
          stream.write({ kind: 'error', message: `Could not prepare the job: ${(err as Error).message}` });
          return;
        }
        const release = await acquireSlots(user!.email);
        try {
          await runEditJob({
            noteId: id,
            scope: job.scope,
            prompt: job.prompt,
            timeoutMs: 300_000,
            stream,
            clientClosed: abort.signal,
            user: user!,
            via: 'claude',
            commitMessage: `wiki: ${id} L${start}-${end} claude block edit`,
            journalNote: id,
            journalFile: job.rel,
            protectedFiles: [job.rel],
            postcondition: (changes, baseline) =>
              blockEditViolation({ noteRel: job.rel, baseline: baseline(job.rel), changes, start: start!, end: end! }),
          });
        } finally {
          release();
        }
      });
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/claude/ask',
    async ({ req, res, user }) => {
      const body = await readBody<{ id?: string; message?: string; sessionId?: string }>(req);
      const { id, message, sessionId } = body;
      if (!id || !message?.trim()) return fail(res, 400, 'missing id/message');
      const meta = noteMeta(id);
      if (!meta) return fail(res, 404, 'Note not found');
      // a session resume is valid only for its issuing user and note
      if (sessionId && !sessionResumable(sessionId, user!.email, id)) {
        return fail(res, 403, 'Unknown chat session for this user and note (sessions reset when the server restarts)');
      }
      const saturated = saturationError(user!.email);
      if (saturated) return fail(res, 429, saturated);
      const release = await acquireSlots(user!.email);
      let ws: Workspace;
      try {
        ws = createWorkspace(jobScope(id));
      } catch (err) {
        release();
        return fail(res, 500, `Could not prepare the workspace: ${(err as Error).message}`);
      }
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // follow-ups on a resumed session skip the scaffold prompt
      const prompt = sessionId ? message! : askPrompt({ meta, message: message! });
      try {
        const remember = (event: ClaudeStreamEvent): void => {
          if ((event.kind === 'init' || event.kind === 'result') && event.sessionId) {
            rememberSession(event.sessionId, user!.email, id);
          }
        };
        const { bin, model } = wikiConfig().claude;
        const result = await runClaudeJob({
          bin,
          model,
          prompt,
          mode: 'readonly',
          cwd: ws.dir,
          resume: sessionId,
          timeoutMs: 300_000,
          killOnDisconnect: true,
          onEvent: (event) => {
            remember(event);
            stream.write(event);
          },
          clientClosed: abort.signal,
        });
        if (result.ok) {
          if (result.sessionId) rememberSession(result.sessionId, user!.email, id);
          stream.write({ kind: 'result', ok: true, summary: result.summary, sessionId: result.sessionId });
        } else {
          stream.write({ kind: 'error', message: result.error });
        }
      } finally {
        ws.destroy();
        stream.close();
        release();
      }
    },
    { auth: true },
  );

  on(
    'POST',
    '/claude/translate',
    async ({ req, res, user }) => {
      const body = await readBody<{ id?: string; targetLang?: string }>(req);
      const { id } = body;
      if (!id) return fail(res, 400, 'missing id');
      const meta = noteMeta(id);
      const located = noteFile(id);
      if (!meta || !located) return fail(res, 404, 'Note not found');
      // default target: the default (unprefixed) locale — or, when the note
      // is already in it, the first other locale of the table
      const locales = wikiConfig().content.locales;
      const defaultCode = locales.find((l) => l.prefix === '')!.code;
      const firstOther = locales.find((l) => l.code !== defaultCode)?.code ?? defaultCode;
      const targetLang = body.targetLang ?? (meta.lang === defaultCode ? firstOther : defaultCode);
      if (targetLang === meta.lang) return fail(res, 400, 'Target language equals the current language');
      const target = meta.locales.find((l) => l.code === targetLang);
      if (!target) return fail(res, 400, `Unsupported target language: ${targetLang}`);
      if (target.exists) return fail(res, 409, `That language version already exists: ${target.id}`);
      if (!noteDir(target.id)) return fail(res, 400, `Invalid target id: ${target.id}`);
      const saturated = saturationError(user!.email);
      if (saturated) return fail(res, 429, saturated);
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      await enqueue(id, async () => {
        // the prompt and the target re-derive from the notes as they are
        // now: a translation or edit that landed while this job sat in the
        // queue changes what is valid
        let job: { sourceRel: string; scope: string[]; prompt: string; journalFile: string };
        try {
          const meta2 = noteMeta(id);
          const located2 = noteFile(id);
          if (!meta2 || !located2) {
            stream.write({ kind: 'error', message: 'Note not found — nothing was changed' });
            return;
          }
          const target2 = meta2.locales.find((l) => l.code === targetLang);
          if (!target2) {
            stream.write({ kind: 'error', message: `Unsupported target language: ${targetLang} — nothing was changed` });
            return;
          }
          if (target2.exists) {
            stream.write({ kind: 'error', message: `That language version already exists: ${target2.id} — nothing was changed` });
            return;
          }
          if (!noteDir(target2.id)) {
            stream.write({ kind: 'error', message: `Invalid target id: ${target2.id} — nothing was changed` });
            return;
          }
          const targetDirRel = join(wikiConfig().content.dir, target2.id);
          const scope = jobScope(id, [targetDirRel]);
          const journalFile = `${targetDirRel}/index.${located2.rel.endsWith('.md') ? 'md' : 'mdx'}`;
          job = {
            sourceRel: located2.rel,
            scope,
            journalFile,
            prompt: translatePrompt({
              meta: meta2,
              targetId: target2.id,
              targetLang,
              companions: scope.filter((s) => s !== dirname(located2.rel) && s !== targetDirRel),
            }),
          };
        } catch (err) {
          stream.write({ kind: 'error', message: `Could not prepare the job: ${(err as Error).message}` });
          return;
        }
        const release = await acquireSlots(user!.email);
        try {
          await runEditJob({
            noteId: id,
            scope: job.scope,
            prompt: job.prompt,
            timeoutMs: 1_800_000,
            stream,
            clientClosed: abort.signal,
            user: user!,
            via: 'translate',
            commitMessage: `wiki: ${target.id} AI translation (from ${id})`,
            journalNote: target.id,
            journalFile: job.journalFile,
            protectedFiles: [job.sourceRel, job.journalFile],
            postcondition: (changes) =>
              translateViolation({ sourceRel: job.sourceRel, targetRel: job.journalFile, changes }),
          });
        } finally {
          release();
        }
      });
      stream.close();
    },
    { auth: true },
  );
}
