/**
 * Bridge to the claude CLI on the host machine.
 *
 * Every job is one `claude -p … --output-format stream-json` child process,
 * its event stream mapped to the wiki's NDJSON protocol (ClaudeStreamEvent)
 * and piped to the browser over a chunked response.
 *
 * Isolation: a job never runs in the project. It runs in a throwaway
 * workspace (./workspace.ts) that holds only the note's directory and the
 * companions the site's config names, its file tools are confined to that
 * directory by permission rules (Read/Edit/Write on `./**` only, no Bash, no
 * Grep/Glob, no network tools), its environment is allowlisted, and what it
 * changed is carried back into the project only after every changed note
 * validates — under the file locks, against the workspace's creation
 * baseline — then journaled (every applied file) and autocommitted. A
 * failed job, an invalid result, a change outside the scope or a conflict
 * with a concurrent edit leaves the project untouched and is reported to
 * the browser as an error.
 *
 *  - block edit / translate: keep running server-side if the browser tab
 *    goes away; the result is applied when the job ends.
 *  - ask: read-only, killed when the client disconnects; the session id is
 *    captured so the chat panel can `--resume` follow-ups, and a resume is
 *    accepted only from the user and note the session was issued for.
 *
 * Jobs are serialized per note (in-memory queue) so two edits cannot race,
 * and capped per user so one user cannot monopolize the machine.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClaudeStreamEvent } from '../shared/types.ts';
import { childEnv } from './child-env.ts';
import { wikiConfig } from './config.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, ndjsonStream, readBody } from './index.ts';
import { askPrompt, blockEditPrompt, translatePrompt } from './prompts.ts';
import { autocommit, journalRevision, noteDir, noteFile, noteMeta, validateSource } from './source.ts';
import { createWorkspace, type Workspace, type WorkspaceChange } from './workspace.ts';

/* ---------------- per-user limits & session ownership ---------------- */

/** concurrent AI jobs one user may hold; beyond it the route answers 429 */
const MAX_JOBS_PER_USER = 2;
const inflight = new Map<string, number>();

/** claim a job slot for `email`; null when the user is at the cap */
function acquireJobSlot(email: string): (() => void) | null {
  const count = inflight.get(email) ?? 0;
  if (count >= MAX_JOBS_PER_USER) return null;
  inflight.set(email, count + 1);
  return () => {
    const left = (inflight.get(email) ?? 1) - 1;
    if (left <= 0) inflight.delete(email);
    else inflight.set(email, left);
  };
}

/** CLI session ids streamed to a user, bound to the note they were issued
 *  for. In-memory only: a server restart forgets them, and a resume of a
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

/* ---------------- claude stream-json → ClaudeStreamEvent ---------------- */

interface StreamJsonLine {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; name?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

/** activity-log label for one tool call: "Read guides/intro/index.mdx" */
function toolLabel(name: string, input: Record<string, unknown> | undefined, cwd: string): string {
  const path = typeof input?.['file_path'] === 'string' ? (input['file_path'] as string) : '';
  const short = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  return `${name} ${short}`.trim();
}

export interface ClaudeJobOptions {
  prompt: string;
  mode: 'edit' | 'readonly';
  /** the job's working directory: the workspace */
  cwd: string;
  resume?: string | undefined;
  timeoutMs: number;
  /** kill the child when the HTTP client disconnects */
  killOnDisconnect: boolean;
  onEvent: (event: ClaudeStreamEvent) => void;
  clientClosed: AbortSignal;
}

export type ClaudeJobResult =
  | { ok: true; summary: string; sessionId: string | null }
  | { ok: false; error: string; sessionId: string | null };

/** file-tool permission rules, confined to the working directory */
const READ_RULES = ['Read(./**)'];
const EDIT_RULES = ['Read(./**)', 'Edit(./**)', 'Write(./**)', 'MultiEdit(./**)'];
const DENIED_TOOLS = 'Bash,Grep,Glob,WebSearch,WebFetch,NotebookEdit,Agent,Task';

/** Run one job; never rejects — every failure is a result with `ok: false`. */
export function runClaudeJob(opts: ClaudeJobOptions): Promise<ClaudeJobResult> {
  return new Promise((resolvePromise) => {
    const { bin, model } = wikiConfig().claude;
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--disallowedTools',
      DENIED_TOOLS,
      '--allowedTools',
      (opts.mode === 'edit' ? EDIT_RULES : READ_RULES).join(','),
      ...(opts.resume ? ['--resume', opts.resume] : []),
      ...(model ? ['--model', model] : []),
    ];
    // allowlisted environment: the child gets process basics, proxies and the
    // CLI's own ANTHROPIC_*/CLAUDE_* variables — never the server's secrets.
    // CLAUDECODE / CLAUDE_CODE_ENTRYPOINT are dropped: a fresh CLI, not a
    // nested session.
    const env = childEnv({
      prefixes: ['ANTHROPIC_', 'CLAUDE_'],
      drop: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    });

    let sessionId: string | null = null;
    let finished = false;
    let stderrTail = '';
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ClaudeJobResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ ok: false, error: `Could not start the claude CLI: ${(err as Error).message}`, sessionId: null });
      return;
    }

    /** SIGTERM, then SIGKILL after a grace window; the promise resolves only
     *  once the child is gone (its close event, or right after SIGKILL) */
    const KILL_GRACE_MS = 5000;
    let pendingKill: ClaudeJobResult | null = null;
    const terminate = (result: ClaudeJobResult): void => {
      if (finished || pendingKill) return;
      pendingKill = result;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(result);
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminate({
        ok: false,
        error: `Job timed out (${Math.round(opts.timeoutMs / 1000)}s) and was terminated`,
        sessionId,
      });
    }, opts.timeoutMs);

    if (opts.killOnDisconnect) {
      opts.clientClosed.addEventListener('abort', () => {
        terminate({ ok: false, error: 'Client disconnected', sessionId });
      });
    }

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const handleLine = (line: StreamJsonLine): void => {
      if (finished) return;
      if (line.type === 'system' && line.subtype === 'init' && line.session_id) {
        sessionId = line.session_id;
        opts.onEvent({ kind: 'init', sessionId });
      } else if (line.type === 'stream_event') {
        const delta = line.event?.delta;
        if (line.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
          opts.onEvent({ kind: 'text', text: delta.text });
        }
      } else if (line.type === 'assistant') {
        for (const block of line.message?.content ?? []) {
          if (block.type === 'tool_use' && block.name) {
            opts.onEvent({ kind: 'tool', label: toolLabel(block.name, block.input, opts.cwd) });
          }
        }
      } else if (line.type === 'result') {
        const id = line.session_id ?? sessionId;
        if (line.is_error) finish({ ok: false, error: line.result || 'The job reported an error', sessionId: id });
        else finish({ ok: true, summary: line.result ?? '', sessionId: id });
      }
    };

    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed: StreamJsonLine;
        try {
          parsed = JSON.parse(line) as StreamJsonLine;
        } catch {
          continue;
        }
        handleLine(parsed);
      }
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        error: `Could not start the claude CLI: ${err.message} (set WIKI_CLAUDE_BIN to point at it)`,
        sessionId,
      });
    });
    child.on('close', (code) => {
      if (pendingKill) return finish(pendingKill);
      finish({
        ok: false,
        error: `claude exited unexpectedly (code ${code})${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`,
        sessionId,
      });
    });
  });
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

/** journal only the changed line span (common prefix/suffix trimmed) */
function journalFileDiff(
  noteId: string,
  before: string,
  after: string,
  user: string,
  via: 'claude' | 'translate',
): void {
  if (before === after) return;
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  journalRevision({
    ts: Date.now(),
    user,
    note: noteId,
    lines: `${head + 1}-${Math.max(head + 1, b.length - tail)}`,
    via,
    before: a.slice(head, a.length - tail).join('\n'),
    after: b.slice(head, b.length - tail).join('\n'),
  });
}

/**
 * Run an edit job in a workspace of `scope`, then validate, apply, journal
 * and commit its changes. Every outcome is reported on the stream: a
 * conflict or containment refusal applies nothing, and a git failure is
 * reported alongside the successful save.
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
    const result = await runClaudeJob({
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
    // every applied change is journaled: the note as a line-span diff, every
    // other file as a whole-file record (lines '*')
    for (const change of changes) {
      if (change.rel === opts.journalFile && change.content !== null) {
        journalFileDiff(opts.journalNote, ws.baseline(change.rel) ?? '', change.content, opts.user.email, opts.via);
      } else {
        journalRevision({
          ts: Date.now(),
          user: opts.user.email,
          note: opts.journalNote,
          file: change.rel,
          lines: '*',
          via: opts.via,
          before: ws.baseline(change.rel) ?? '',
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
      const meta = noteMeta(id);
      const located = noteFile(id);
      if (!meta || !located) return fail(res, 404, 'Note not found');
      const lines = readFileSync(located.file, 'utf8').split('\n');
      if (start! < 1 || end! < start! || end! > lines.length) return fail(res, 416, 'line range outside the file');
      const source = lines.slice(start! - 1, end).join('\n');
      const scope = jobScope(id);
      const release = acquireJobSlot(user!.email);
      if (!release) return fail(res, 429, `You already have ${MAX_JOBS_PER_USER} AI jobs running — wait for one to finish`);
      try {
        const stream = ndjsonStream(res);
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        await enqueue(id, () =>
          runEditJob({
            noteId: id,
            scope,
            prompt: blockEditPrompt({ meta, start: start!, end: end!, source, instruction: instruction!, companions: scope.filter((s) => s !== dirname(located.rel)) }),
            timeoutMs: 300_000,
            stream,
            clientClosed: abort.signal,
            user: user!,
            via: 'claude',
            commitMessage: `wiki: ${id} L${start}-${end} claude block edit`,
            journalNote: id,
            journalFile: located.rel,
            protectedFiles: [located.rel],
          }),
        );
        stream.close();
      } finally {
        release();
      }
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
      // a session may only be resumed by the user and note it was issued for
      if (sessionId && !sessionResumable(sessionId, user!.email, id)) {
        return fail(res, 403, 'Unknown chat session for this user and note (sessions reset when the server restarts)');
      }
      const release = acquireJobSlot(user!.email);
      if (!release) return fail(res, 429, `You already have ${MAX_JOBS_PER_USER} AI jobs running — wait for one to finish`);
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
        const result = await runClaudeJob({
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
      const targetDirAbs = noteDir(target.id);
      if (!targetDirAbs) return fail(res, 400, `Invalid target id: ${target.id}`);
      const targetDirRel = join(wikiConfig().content.dir, target.id);
      const scope = jobScope(id, [targetDirRel]);
      const release = acquireJobSlot(user!.email);
      if (!release) return fail(res, 429, `You already have ${MAX_JOBS_PER_USER} AI jobs running — wait for one to finish`);
      try {
        const stream = ndjsonStream(res);
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const journalFile = `${targetDirRel}/index.${located.rel.endsWith('.md') ? 'md' : 'mdx'}`;
        await enqueue(id, () =>
          runEditJob({
            noteId: id,
            scope,
            prompt: translatePrompt({
              meta,
              targetId: target.id,
              targetLang,
              companions: scope.filter((s) => s !== dirname(located.rel) && s !== targetDirRel),
            }),
            timeoutMs: 1_800_000,
            stream,
            clientClosed: abort.signal,
            user: user!,
            via: 'translate',
            commitMessage: `wiki: ${target.id} AI translation (from ${id})`,
            journalNote: target.id,
            journalFile,
            protectedFiles: [located.rel, journalFile],
          }),
        );
        stream.close();
      } finally {
        release();
      }
    },
    { auth: true },
  );
}
