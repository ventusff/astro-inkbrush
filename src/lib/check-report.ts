/**
 * check-report — the report form of the content checks
 * (scripts/check-content.mjs, scripts/check-language.mjs), written by them and
 * read back by the syndication gate (scripts/syndication-gate.mjs).
 *
 * A report is lines. A file's block opens at the start of a line with
 * `✗ <path>` — findings: the file fails the check — or `⚠ <path>` —
 * warnings: listed, never failing the run — and holds that file's entries
 * on the lines indented below it; an empty line ends a block. Every other
 * line opens a block of its own kind: the warnings' count line
 * (warningsCount()), the code-language note (codeLanguageAdvice() in
 * code-language.ts), a summary, or whatever another check prints.
 *
 * scopeReport() narrows a whole repository's report to the files one
 * submission brings: every finding stays — a failing file anywhere is why
 * the run failed — while warnings stay only for the files in scope, and the
 * count line and the code-language note are written anew for what is left.
 */
import { codeLanguageAdvice, codeLanguagePlaceOf, CODE_LANGUAGE_ADVICE_HEAD, type CodePlace } from './code-language.ts';

export type FileMark = '✗' | '⚠';

/** a file's block: `<mark> <path>`, then each entry indented (an entry of several lines keeps them together) */
export function fileBlock(mark: FileMark, path: string, entries: readonly string[]): string[] {
  return [`${mark} ${path}`, ...entries.flatMap((entry) => entry.split('\n').map((line) => `  ${line}`))];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** the count line after the warning blocks */
export function warningsCount(warnings: number, files: number): string {
  return `${plural(warnings, 'warning')} in ${plural(files, 'file')} (listed, not failing the run).`;
}

const WARNINGS_COUNT = /^\d+ warnings? in \d+ files? \(listed, not failing the run\)\.$/;

type Block =
  | { kind: 'file'; mark: FileMark; path: string; lines: string[] }
  | { kind: 'count' | 'advice' | 'other'; lines: string[] };

function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const line of lines) {
    if (line === '') {
      open = null;
    } else if (open && /^\s/.test(line)) {
      open.lines.push(line);
    } else {
      const file = /^(✗|⚠) (\S.*)$/.exec(line);
      open = file
        ? { kind: 'file', mark: file[1] as FileMark, path: file[2]!, lines: [line] }
        : { kind: WARNINGS_COUNT.test(line) ? 'count' : line === CODE_LANGUAGE_ADVICE_HEAD ? 'advice' : 'other', lines: [line] };
      blocks.push(open);
    }
  }
  return blocks;
}

/**
 * The report narrowed to the files `inScope` accepts: their blocks first —
 * findings and warnings, in the report's order — then every other block in
 * its place, without the warning blocks of files out of scope; the count line
 * counts the warnings left and the code-language note names the places the
 * remaining file blocks hold, each dropped when nothing is left for it.
 * Empty lines are not kept.
 */
export function scopeReport(lines: readonly string[], inScope: (path: string) => boolean): string[] {
  const blocks = blocksOf(lines).filter((b) => b.kind !== 'file' || b.mark === '✗' || inScope(b.path));
  const own = blocks.filter((b) => b.kind === 'file' && inScope(b.path));
  const files = blocks.filter((b): b is Extract<Block, { kind: 'file' }> => b.kind === 'file');
  const warnings = files.filter((b) => b.mark === '⚠');
  const places = new Set<CodePlace>();
  for (const b of files) {
    for (const line of b.lines.slice(1)) {
      const place = codeLanguagePlaceOf(line);
      if (place) places.add(place);
    }
  }
  const rest = blocks.filter((b) => !own.includes(b)).flatMap((b) => {
    if (b.kind === 'count') {
      const count = warnings.reduce((sum, w) => sum + w.lines.length - 1, 0);
      return count > 0 ? [warningsCount(count, warnings.length)] : [];
    }
    if (b.kind === 'advice') return places.size > 0 ? codeLanguageAdvice(places) : [];
    return b.lines;
  });
  return [...own.flatMap((b) => b.lines), ...rest];
}
