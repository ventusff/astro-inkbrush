/**
 * One claude CLI child process: spawn, stream-json → ClaudeStreamEvent
 * mapping, timeout and kill escalation.
 *
 * Settlement contract: the job promise settles only once the child's close
 * event fires — the semantic outcome (the stream's result line, a timeout,
 * a disconnect) is recorded when it happens, but until close the child may
 * still be writing into its working directory, so no caller reads the
 * workspace before the promise resolves. Termination escalates SIGTERM →
 * SIGKILL after a grace window, and even after SIGKILL the promise waits
 * for close. The one exception is a spawn that never produced a process
 * (no pid): there is nothing to wait for, and some spawn failures emit no
 * close event.
 *
 * Kept free of config imports (the caller passes bin/model) so the process
 * lifecycle is unit-testable against a fake bin.
 */
import { spawn } from 'node:child_process';

import type { ClaudeStreamEvent } from '../shared/types.ts';
import { childEnv } from './child-env.ts';

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
  /** the claude CLI executable (inkbrush.config.ts → claude.bin) */
  bin: string;
  /** `--model` override; null = the CLI's own default */
  model: string | null;
  prompt: string;
  mode: 'edit' | 'readonly';
  /** the job's working directory: the workspace */
  cwd: string;
  resume?: string | undefined;
  timeoutMs: number;
  /** SIGTERM → SIGKILL escalation window (default 5s) */
  killGraceMs?: number | undefined;
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

const DEFAULT_KILL_GRACE_MS = 5000;

/** Run one job; never rejects — every failure is a result with `ok: false`. */
export function runClaudeJob(opts: ClaudeJobOptions): Promise<ClaudeJobResult> {
  return new Promise((resolvePromise) => {
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
      ...(opts.model ? ['--model', opts.model] : []),
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
    /** the job's semantic outcome; the first recording wins, and the promise
     *  settles with it only from the child's close event */
    let outcome: ClaudeJobResult | null = null;
    const record = (result: ClaudeJobResult): void => {
      outcome ??= result;
    };
    const finish = (result: ClaudeJobResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin, args, { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ ok: false, error: `Could not start the claude CLI: ${(err as Error).message}`, sessionId: null });
      return;
    }

    /** record the outcome and terminate: SIGTERM, then SIGKILL after the
     *  grace window; settlement still waits for the close event */
    let killing = false;
    const terminate = (result: ClaudeJobResult): void => {
      if (finished || killing) return;
      killing = true;
      record(result);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
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
      if (finished || outcome) return;
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
        // the semantic result; the promise settles at close, when the child
        // can no longer write into the workspace
        const id = line.session_id ?? sessionId;
        if (line.is_error) record({ ok: false, error: line.result || 'The job reported an error', sessionId: id });
        else record({ ok: true, summary: line.result ?? '', sessionId: id });
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
      const result: ClaudeJobResult = {
        ok: false,
        error: `Could not start the claude CLI: ${err.message} (set WIKI_CLAUDE_BIN to point at it)`,
        sessionId,
      };
      record(result);
      // a spawn that never produced a process emits no close event — there
      // is no child to wait for, settle now
      if (child.pid === undefined) finish(result);
    });
    child.on('close', (code) => {
      finish(
        outcome ?? {
          ok: false,
          error: `claude exited unexpectedly (code ${code})${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`,
          sessionId,
        },
      );
    });
  });
}
