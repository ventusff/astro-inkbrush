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
 * Grep/Glob, no network tools), and what it changed is carried back into
 * the project only after every changed note validates — then journaled and
 * autocommitted. A failed job, an invalid result or a change outside the
 * scope leaves the project untouched and is reported to the browser as an
 * error.
 *
 *  - block edit / translate: keep running server-side if the browser tab
 *    goes away; the result is applied when the job ends.
 *  - ask: read-only, killed when the client disconnects; the session id is
 *    captured so the chat panel can `--resume` follow-ups.
 *
 * Jobs are serialized per note (in-memory queue) so two edits cannot race.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClaudeStreamEvent } from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, ndjsonStream, readBody } from './index.ts';
import { askPrompt, blockEditPrompt, translatePrompt } from './prompts.ts';
import { autocommit, journalRevision, noteDir, noteFile, noteMeta, validateSource } from './source.ts';
import { projectRoot } from './store.ts';
import { createWorkspace, type Workspace, type WorkspaceChange } from './workspace.ts';

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
    // the child is a fresh CLI, not a nested session
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];

    let sessionId: string | null = null;
    let finished = false;
    let stderrTail = '';
    const finish = (result: ClaudeJobResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ ok: false, error: `Could not start the claude CLI: ${(err as Error).message}`, sessionId: null });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, error: `Job timed out (${Math.round(opts.timeoutMs / 1000)}s) and was terminated`, sessionId });
    }, opts.timeoutMs);

    if (opts.killOnDisconnect) {
      opts.clientClosed.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish({ ok: false, error: 'Client disconnected', sessionId });
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
 * and commit its changes. Every outcome is reported on the stream.
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
  /** the note the journal entry is about, and its project-relative file */
  journalNote: string;
  journalFile: string;
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
      onEvent: (event) => stream.write(event),
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
    const problem = await validateChanges(changes);
    if (problem) {
      stream.write({ kind: 'error', message: `The result would not build — nothing was changed: ${problem}` });
      return;
    }
    const journaled = changes.find((c) => c.rel === opts.journalFile);
    const journalAbs = join(projectRoot(), opts.journalFile);
    const before = journaled && existsSync(journalAbs) ? readFileSync(journalAbs, 'utf8') : '';
    ws.apply(changes);
    if (journaled && journaled.content !== null) {
      journalFileDiff(opts.journalNote, before, journaled.content, opts.user.email, opts.via);
    }
    await autocommit(
      [...new Set(changes.map((c) => dirname(c.rel)))],
      opts.commitMessage,
      opts.user.name,
    );
    stream.write({ kind: 'result', ok: true, summary: result.summary, sessionId: result.sessionId });
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
        }),
      );
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/claude/ask',
    async ({ req, res }) => {
      const body = await readBody<{ id?: string; message?: string; sessionId?: string }>(req);
      const { id, message, sessionId } = body;
      if (!id || !message?.trim()) return fail(res, 400, 'missing id/message');
      const meta = noteMeta(id);
      if (!meta) return fail(res, 404, 'Note not found');
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // follow-ups on a resumed session skip the scaffold prompt
      const prompt = sessionId ? message! : askPrompt({ meta, message: message! });
      const ws = createWorkspace(jobScope(id));
      try {
        const result = await runClaudeJob({
          prompt,
          mode: 'readonly',
          cwd: ws.dir,
          resume: sessionId,
          timeoutMs: 300_000,
          killOnDisconnect: true,
          onEvent: (event) => stream.write(event),
          clientClosed: abort.signal,
        });
        if (result.ok) stream.write({ kind: 'result', ok: true, summary: result.summary, sessionId: result.sessionId });
        else stream.write({ kind: 'error', message: result.error });
      } finally {
        ws.destroy();
        stream.close();
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
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
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
          journalFile: `${targetDirRel}/index.${located.rel.endsWith('.md') ? 'md' : 'mdx'}`,
        }),
      );
      stream.close();
    },
    { auth: true },
  );
}
