/**
 * Shape constraints on an AI job's result, checked between the workspace
 * diff and validation/application. The workspace confines WHERE a job may
 * write; these postconditions confine WHAT a job may change:
 *  - a block edit may rewrite only the selected line span of the note file
 *    (companion files remain free);
 *  - a translation must leave the source note untouched and must produce
 *    the exact target file.
 * Also the revision-span rule the journal uses: a change whose baseline
 * file does not exist, and a change that spans the whole file, journals as
 * lines '*' — an audit row the one-click revert refuses.
 * Kept free of config/server imports so every rule is unit-testable.
 */
import type { WorkspaceChange } from './workspace.ts';

/**
 * A block edit must keep every line outside the selected start..end span
 * byte-identical to the baseline: the changed file has to be the baseline's
 * outside lines spliced around a replacement block. Returns a violation
 * message, or null when the change is within bounds. A missing change to
 * the note file passes (the job may have changed companions only).
 */
export function blockEditViolation(opts: {
  /** project-relative path of the note's source file */
  noteRel: string;
  /** the note file's content at workspace creation; null = did not exist */
  baseline: string | null;
  changes: WorkspaceChange[];
  /** selected span, 1-based inclusive line numbers in the baseline */
  start: number;
  end: number;
}): string | null {
  const change = opts.changes.find((c) => c.rel === opts.noteRel);
  if (!change) return null;
  if (change.content === null) return `The job deleted the note's own file (${opts.noteRel})`;
  if (opts.baseline === null) {
    return `The note file (${opts.noteRel}) has no baseline to edit a block of`;
  }
  const before = opts.baseline.split('\n');
  const after = change.content.split('\n');
  const prefix = before.slice(0, opts.start - 1);
  const suffix = before.slice(opts.end);
  const outside = `lines outside the selected block (L${opts.start}-${opts.end}) of ${opts.noteRel}`;
  if (after.length < prefix.length + suffix.length) {
    return `The job changed ${outside}`;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (after[i] !== prefix[i]) return `The job changed ${outside}`;
  }
  for (let i = 0; i < suffix.length; i++) {
    if (after[after.length - suffix.length + i] !== suffix[i]) {
      return `The job changed ${outside}`;
    }
  }
  return null;
}

/**
 * A translation must not touch the source note in any way, and the changes
 * must contain the target file with content. Returns a violation message,
 * or null when both hold.
 */
export function translateViolation(opts: {
  /** project-relative path of the source note's file */
  sourceRel: string;
  /** project-relative path the translation must be written to */
  targetRel: string;
  changes: WorkspaceChange[];
}): string | null {
  const source = opts.changes.find((c) => c.rel === opts.sourceRel);
  if (source) return `The job modified the source note (${opts.sourceRel})`;
  const target = opts.changes.find((c) => c.rel === opts.targetRel);
  if (!target || target.content === null) {
    return `The job did not produce the target file (${opts.targetRel})`;
  }
  return null;
}

/** how a change is journaled: a revertible line-span diff, or an
 *  audit-only whole-file row (lines '*') */
export interface RevisionSpan {
  /** "start-end" (1-based, in the after-file), or '*' for whole-file scale */
  lines: string;
  before: string;
  after: string;
}

/**
 * The journal span of one file change: the changed line range with the
 * common prefix/suffix trimmed. Null when the contents are equal. A change
 * that shares no leading and no trailing line with its baseline is
 * whole-file scale and journals as lines '*' with the full contents —
 * an audit row, not a revertible span (an empty baseline always is).
 */
export function revisionSpan(before: string, after: string): RevisionSpan | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  if (head === 0 && tail === 0) return { lines: '*', before, after };
  return {
    lines: `${head + 1}-${Math.max(head + 1, b.length - tail)}`,
    before: a.slice(head, a.length - tail).join('\n'),
    after: b.slice(head, b.length - tail).join('\n'),
  };
}
