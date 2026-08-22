/**
 * Bridge to the claude-cli running on the host machine.
 *
 * Every job = one `claude -p … --output-format stream-json` child process in
 * the repo root, its event stream mapped to the wiki's NDJSON protocol
 * (ClaudeStreamEvent) and piped to the browser over a chunked fetch response.
 *
 *  - block edit / translate: claude gets Edit/Write tools (acceptEdits) but
 *    never Bash; jobs keep running server-side even if the browser tab goes
 *    away, and the resulting file change is journaled as a revision.
 *  - ask: read-only toolset, killed when the client disconnects, session_id
 *    captured so the chat panel can --resume follow-ups.
 *
 * Jobs are serialized per note (in-memory queue) so two edits can't race.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ClaudeStreamEvent } from '../shared/types';
import { wikiConfig } from './config';
import type { RouteRegistrar } from './index';
import { fail, ndjsonStream, readBody } from './index';
import { askPrompt, blockEditPrompt, translatePrompt } from './prompts';
import { autocommit, journalRevision, noteFile, noteMeta } from './source';
import { projectRoot } from './store';

/* ---------------- per-note job queue ---------------- */

const queues = new Map<string, Promise<void>>();

function enqueue(noteId: string, job: () => Promise<void>): Promise<void> {
  const prev = queues.get(noteId) ?? Promise.resolve();
  const next = prev.then(job, job);
  queues.set(noteId, next);
  // drop the entry once the queue drains (the Map used to only grow — every
  // note ever touched kept a settled Promise until process exit)
  next.finally(() => {
    if (queues.get(noteId) === next) queues.delete(noteId);
  });
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

/** activity-log label for one tool call, e.g. "Read guides/intro/index.mdx"
 *  (paths shortened to repo-relative; the client renders the label verbatim) */
function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const path = typeof input?.['file_path'] === 'string' ? (input['file_path'] as string) : '';
  const rootPrefix = projectRoot().replace(/\/$/, '');
  const short = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length + 1) : path;
  return `${name} ${short}`.trim();
}

export interface ClaudeJobOptions {
  prompt: string;
  mode: 'edit' | 'readonly';
  resume?: string | undefined;
  timeoutMs: number;
  /** kill the child when the HTTP client disconnects */
  killOnDisconnect: boolean;
  onEvent: (event: ClaudeStreamEvent) => void;
  clientClosed: AbortSignal;
}

export function runClaudeJob(opts: ClaudeJobOptions): Promise<void> {
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
      'Bash,WebSearch,WebFetch,NotebookEdit',
      ...(opts.mode === 'edit'
        ? ['--allowedTools', 'Read,Grep,Glob,Edit,Write', '--permission-mode', 'acceptEdits']
        : ['--allowedTools', 'Read,Grep,Glob']),
      ...(opts.resume ? ['--resume', opts.resume] : []),
      ...(model ? ['--model', model] : []),
    ];
    // strip the nested-session marker so the child behaves like a fresh CLI
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];

    const child = spawn(bin, args, { cwd: projectRoot(), env, stdio: ['ignore', 'pipe', 'pipe'] });

    let sessionId: string | null = null;
    let finished = false;
    let stderrTail = '';
    const finish = (event?: ClaudeStreamEvent): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (event) opts.onEvent(event);
      resolvePromise();
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ kind: 'error', message: `Job timed out (${Math.round(opts.timeoutMs / 1000)}s) and was terminated` });
    }, opts.timeoutMs);

    if (opts.killOnDisconnect) {
      opts.clientClosed.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish();
      });
    }

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
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
            opts.onEvent({ kind: 'tool', label: toolLabel(block.name, block.input) });
          }
        }
      } else if (line.type === 'result') {
        finish({
          kind: 'result',
          ok: !line.is_error,
          summary: line.result ?? '',
          sessionId: line.session_id ?? sessionId,
        });
      }
    };

    child.on('error', (err) => {
      finish({ kind: 'error', message: `Could not start the claude CLI: ${err.message} (set WIKI_CLAUDE_BIN to point at it)` });
    });
    child.on('close', (code) => {
      if (!finished) {
        finish({
          kind: 'error',
          message: `claude exited unexpectedly (code ${code})${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`,
        });
      }
    });
  });
}

/* ---------------- revision journaling for edit jobs ---------------- */

function snapshot(relFile: string): string {
  try {
    return readFileSync(join(projectRoot(), relFile), 'utf8');
  } catch {
    return '';
  }
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
      const source = lines.slice(start! - 1, end).join('\n');
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      await enqueue(id, async () => {
        const before = snapshot(meta.file);
        await runClaudeJob({
          prompt: blockEditPrompt({ meta, start: start!, end: end!, source, instruction: instruction! }),
          mode: 'edit',
          timeoutMs: 300_000,
          killOnDisconnect: false,
          onEvent: (event) => stream.write(event),
          clientClosed: abort.signal,
        });
        journalFileDiff(id, before, snapshot(meta.file), user!.email, 'claude');
        // whole note dir: claude may also touch co-located demo .ts files
        await autocommit(dirname(meta.file), `wiki: ${id} L${start}-${end} claude block edit`, user!.name);
      });
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/claude/ask',
    async ({ req, res, user: _user }) => {
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
      await runClaudeJob({
        prompt,
        mode: 'readonly',
        resume: sessionId,
        timeoutMs: 300_000,
        killOnDisconnect: true,
        onEvent: (event) => stream.write(event),
        clientClosed: abort.signal,
      });
      stream.close();
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
      if (!meta) return fail(res, 404, 'Note not found');
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
      const targetId = target.id;
      const stream = ndjsonStream(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      await enqueue(id, async () => {
        await runClaudeJob({
          prompt: translatePrompt({ meta, targetId, targetLang }),
          mode: 'edit',
          timeoutMs: 1_800_000,
          killOnDisconnect: false,
          onEvent: (event) => stream.write(event),
          clientClosed: abort.signal,
        });
        const targetMeta = noteMeta(targetId);
        if (targetMeta) {
          journalFileDiff(targetId, '', snapshot(targetMeta.file), user!.email, 'translate');
          // target dir (new note) + source dir (translate also fills the demo
          // .ts ctx.t dictionaries co-located with the base note)
          await autocommit(
            [dirname(targetMeta.file), dirname(meta.file)],
            `wiki: ${targetId} AI translation (from ${id})`,
            user!.name,
          );
          // post-write syntax gate: a broken translation must be flagged loudly
          if (targetMeta.file.endsWith('.mdx')) {
            const { validateMdx } = await import('./source');
            const error = await validateMdx(snapshot(targetMeta.file));
            if (error) {
              stream.write({
                kind: 'error',
                message: `Translation written to ${targetMeta.file}, but MDX compilation failed: ${error}`,
              } satisfies ClaudeStreamEvent);
            }
          }
        } else {
          stream.write({
            kind: 'error',
            message: `Job finished but the target file was not created (${targetId})`,
          } satisfies ClaudeStreamEvent);
        }
      });
      stream.close();
    },
    { auth: true },
  );
}
