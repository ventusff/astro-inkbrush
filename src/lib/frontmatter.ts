/**
 * splitFrontmatter — the one frontmatter reading shared by every consumer
 * (note scanning, save-time validation, frontmatter field access, the
 * Obsidian importer, the check CLIs), so acceptance can never drift
 * between them.
 *
 * Acceptance matches the block Astro recognises: an optional BOM, any
 * number of leading blank lines, LF or CRLF line breaks, and `---` fences
 * each alone on their line (trailing spaces allowed). The closing fence
 * must sit at a line start; a block that never closes is not frontmatter.
 *
 * The YAML is parsed with the `yaml` package (the grammar Astro reads).
 * Splitting never throws: a present block whose YAML does not parse — or
 * parses to something other than a mapping — yields `data: {}` plus a
 * positioned `error`, so tolerant consumers read `data` and strict ones
 * report `error`.
 */
import { parseDocument } from 'yaml';

/** `---` (with optional trailing blanks) opening the source after an
 *  optional BOM and any blank lines */
const OPEN_FENCE_RE = /^\uFEFF?(?:[ \t\r]*\n)*---[ \t]*\r?\n/;

/** the closing fence: `---` alone on its line (trailing blanks allowed) */
const CLOSE_FENCE_RE = /^---[ \t]*(?=\r?\n|$)/m;

export interface FrontmatterError {
  /** one line, position suffix stripped (`line`/`column` carry it) */
  message: string;
  /** 1-based line in the whole source (not the YAML block), when known */
  line?: number | undefined;
  /** 1-based column on that line, when known */
  column?: number | undefined;
}

export interface SplitFrontmatter {
  /** a frontmatter block opens the source */
  present: boolean;
  /** the YAML text between the fences ('' without a block) */
  raw: string;
  /** [start, end) offsets of the block in the source — BOM, leading blank
   *  lines and both fences included, the newline after the closing fence
   *  not; 0/0 without a block */
  start: number;
  end: number;
  /** 1-based source line where the YAML text starts (0 without a block) */
  contentLine: number;
  /** the source with every block character except line breaks replaced by
   *  a space — line numbers and character offsets both preserved */
  body: string;
  /** the parsed mapping; {} when the block is absent, empty, broken or
   *  not a mapping */
  data: Record<string, unknown>;
  /** why `data` is empty despite a present block; null when `data` holds
   *  the block's mapping (or there is no block) */
  error: FrontmatterError | null;
}

/**
 * Split `source` into its frontmatter block and body. Never throws; the
 * result names the block's offsets (for equal-length masking), a body with
 * the block blanked (for line-true compilation of the rest), the parsed
 * mapping, and a positioned error when the block cannot be read as one.
 */
export function splitFrontmatter(source: string): SplitFrontmatter {
  const absent: SplitFrontmatter = {
    present: false,
    raw: '',
    start: 0,
    end: 0,
    contentLine: 0,
    body: source,
    data: {},
    error: null,
  };
  const open = OPEN_FENCE_RE.exec(source);
  if (!open) return absent;
  const rest = source.slice(open[0].length);
  const close = CLOSE_FENCE_RE.exec(rest);
  if (!close) return absent;

  const raw = rest.slice(0, close.index).replace(/\r?\n$/, '');
  const end = open[0].length + close.index + close[0].length;
  const contentLine = open[0].split('\n').length;
  const body = source.slice(0, end).replace(/[^\r\n]/g, ' ') + source.slice(end);

  let data: Record<string, unknown> = {};
  let error: FrontmatterError | null = null;
  const doc = parseDocument(raw, { logLevel: 'silent' });
  const bad = doc.errors[0];
  if (bad) {
    const pos = bad.linePos?.[0];
    error = {
      message: (bad.message.split('\n')[0] ?? bad.message).replace(/ at line \d+, column \d+:?$/, ''),
      line: pos ? contentLine - 1 + pos.line : undefined,
      column: pos?.col,
    };
  } else {
    const value: unknown = doc.toJS();
    if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      data = value as Record<string, unknown>;
    } else if (value !== null && value !== undefined) {
      error = { message: 'frontmatter is not a YAML mapping', line: contentLine };
    }
  }
  return { present: true, raw, start: 0, end, contentLine, body, data, error };
}
