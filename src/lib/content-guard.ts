/**
 * remarkContentGuard — build-time gate: what you wrote is what the page shows.
 *
 * Markdown/MDX has corners that never error and silently deform instead;
 * the guard turns each into a build failure:
 *   - emphasis markers that fail to pair: in `……报文。**同时` neither end
 *     satisfies CommonMark's flanking rules, so the `**` leaks to the reader
 *     verbatim;
 *   - MDX evaluates `{0,1,2,3}` in prose as a JS comma expression — the page
 *     shows just `3`;
 *   - a `+` left at the start of a wrapped line turns half a sentence into a
 *     bullet;
 *   - a single-line `$$x$$` is silently treated by remark-math as small
 *     inline math;
 *   - an HTML entity like `&lt;` inside a formula, or a broken macro, renders
 *     as red KaTeX error text while the build stays green.
 * The guard checks all of these in one pass over the parsed tree; a finding
 * fails the build with file:line:column instead of shipping a deformed page.
 *
 * "This marker COULD open emphasis" is decided with the parser's own
 * left/right-flanking rules (including the CJK extension) — character
 * classification comes straight from micromark-extension-cjk-friendly-util,
 * so there is zero drift from the real parser:
 *   - a marker that can only close, with nothing to close, doesn't count:
 *     `M87*`, `A* search`, `ps_ SKU` — the parser has already proven no
 *     opener precedes it, so it is a literal character and can never become
 *     emphasis;
 *   - a marker that can open counts: `*.md`, `_meta`, `**unclosed` — any
 *     later marker could italicize half a sentence;
 *   - runs of two or more (`**` `__` `~~`) count whether opening or closing:
 *     no prose legitimately needs them literal.
 * `5 * 3` (whitespace both sides), `snake_case` (letters both sides) and
 * escaped `\*` are naturally excluded.
 *
 * The math check re-renders every math node with KaTeX in strict mode
 * (production rendering is throwOnError:false — a broken macro ships as red
 * text under a green build). Sites without remark-math have no math nodes;
 * a `$$` in their prose is reported as "math syntax leaking into prose".
 *
 * Mount it after the parser extensions and before any transformer: it sees
 * the freshly parsed tree, so plugins that rewrite text nodes (wikilinks and
 * friends) can't hide anything from it. Works for md and mdx; code blocks
 * and inline code are not text nodes, so they are naturally out of scope.
 */
import {
  classifyCharacter,
  classifyPrecedingCharacter,
  isCjk,
  isCjkOrIvs,
  isNonCjkPunctuation,
  isSpaceOrPunctuation,
  isUnicodeWhitespace,
} from 'micromark-extension-cjk-friendly-util';
import katex from 'katex';

export interface ContentGuardOptions {
  /**
   * Check for markdown/math markers inside component props (omit = off).
   * Prop values are plain strings — `$…$` and `**` display verbatim; only
   * whitelisted "component → props" pairs are rendered at build time and may
   * carry such markers. Example: `{ PaperCard: ['alias', 'full', 'meta'] }`.
   */
  renderedProps?: Record<string, readonly string[]> | undefined;
  /**
   * Check for hand-written heading numbers (default off). Enable on sites
   * that auto-number headings at build time: `## 1. Pillars` would render as
   * the double-numbered "5.1 1. Pillars".
   */
  autoNumberedHeadings?: boolean | undefined;
}

interface Point {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface MdNode {
  type: string;
  depth?: number | undefined;
  name?: string | null | undefined;
  value?: string | undefined;
  attributes?: { type: string; name?: string; value?: unknown }[] | undefined;
  children?: MdNode[] | undefined;
  position?: { start: Point; end: Point } | undefined;
}

/** the minimal slice of vfile we need: body, path, throwing a fatal error */
interface FileLike {
  value: unknown;
  path?: string | undefined;
  fail(reason: string): never;
}

interface Finding {
  line: number;
  column: number;
  runLength: number;
  what: string;
  fix: string;
}

/** strings that might be emphasis markers: asterisk runs, underscore runs,
 *  tilde runs of two or more */
const MARKER_RUN = /\*+|_+|~{2,}/g;

/** how much of a line the excerpt shows the reader */
const EXCERPT_WIDTH = 96;

/** an odd number of backslashes before the marker → the author explicitly
 *  wants the literal character */
function escaped(text: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i -= 1) n += 1;
  return n % 2 === 1;
}

/** the n-th code point before `at` (surrogate-pair aware), or null when
 *  there is none (the parser treats the file boundary as whitespace) */
function codeBefore(text: string, at: number, n: 1 | 2): number | null {
  const chars = [...text.slice(Math.max(0, at - 4), at)];
  return chars[chars.length - n]?.codePointAt(0) ?? null;
}

/**
 * Can this marker run open / close an emphasis span — a faithful port of
 * micromark-extension-cjk-friendly's attention rules, including the `*` vs
 * `_` difference.
 */
function flanking(text: string, at: number, run: string): { open: boolean; close: boolean } {
  const previous = codeBefore(text, at, 1);
  const before = classifyCharacter(previous);
  const beforePrimary = classifyPrecedingCharacter(before, () => codeBefore(text, at, 2), previous);
  const after = classifyCharacter(text.codePointAt(at + run.length) ?? null);

  const beforeNonCjkPunctuation = isNonCjkPunctuation(beforePrimary);
  const beforeSpaceOrNonCjkPunctuation = beforeNonCjkPunctuation || isUnicodeWhitespace(beforePrimary);
  const afterNonCjkPunctuation = isNonCjkPunctuation(after);
  const afterSpaceOrNonCjkPunctuation = afterNonCjkPunctuation || isUnicodeWhitespace(after);

  const open =
    !afterSpaceOrNonCjkPunctuation ||
    (afterNonCjkPunctuation && (beforeSpaceOrNonCjkPunctuation || isCjkOrIvs(beforePrimary)));
  const close =
    !beforeSpaceOrNonCjkPunctuation ||
    (beforeNonCjkPunctuation && (afterSpaceOrNonCjkPunctuation || isCjk(after)));

  if (run.startsWith('_')) {
    return {
      open: open && (isSpaceOrPunctuation(beforePrimary) || !close),
      close: close && (isSpaceOrPunctuation(after) || !open),
    };
  }
  return { open, close };
}

/** is this emphasis-marker run, left in prose, an incident */
function isLeakedEmphasis(text: string, at: number, run: string): boolean {
  if (escaped(text, at)) return false;
  const { open, close } = flanking(text, at, run);
  return open || (run.length > 1 && close);
}

/** `{/* comment *\/}` and template literals are the only two legitimate
 *  expressions in prose */
function isIntendedExpression(value: string): boolean {
  const v = value.trim();
  return /^\/\*[\s\S]*\*\/$/.test(v) || v.startsWith('`');
}

const MANUAL_NUMBER = /^\s*\d+(?:\.\d+)*[.、．]\s/;

function pointAt(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: (before.match(/\n/g)?.length ?? 0) + 1, column: offset - lastBreak };
}

/** excerpt the offending line; when the marker sits far right, window around it */
function excerpt(lineText: string, column: number, runLength: number): string {
  let start = 0;
  if (lineText.length > EXCERPT_WIDTH) {
    start = Math.max(0, Math.min(column - 1 - EXCERPT_WIDTH / 2, lineText.length - EXCERPT_WIDTH));
  }
  const shown = lineText.slice(start, start + EXCERPT_WIDTH);
  const head = start > 0 ? '…' : '';
  const tail = start + EXCERPT_WIDTH < lineText.length ? '…' : '';
  const caret = ' '.repeat(head.length + column - 1 - start) + '^'.repeat(Math.max(1, Math.min(runLength, EXCERPT_WIDTH)));
  return `${head}${shown}${tail}\n${caret}`;
}

export function remarkContentGuard(options: ContentGuardOptions = {}) {
  return (tree: MdNode, file: FileLike): void => {
    const source = String(file.value ?? '');
    const findings: Finding[] = [];
    const found = (offset: number | undefined, fallback: Point, runLength: number, what: string, fix: string): void => {
      const at = offset !== undefined ? pointAt(source, offset) : { line: fallback.line, column: fallback.column };
      findings.push({ ...at, runLength, what, fix });
    };

    const inspectText = (node: MdNode, nearest: Point): void => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      // parser-produced nodes carry source positions: read the original text,
      // so escapes and line/column are exact. Nodes minted by other plugins
      // have no position: fall back to the node's text, located at the
      // nearest positioned ancestor.
      const positioned = start !== undefined && end !== undefined;
      const text = positioned ? source.slice(start, end) : (node.value ?? '');
      const base = positioned ? start : undefined;

      for (const m of text.matchAll(MARKER_RUN)) {
        if (!isLeakedEmphasis(text, m.index, m[0])) continue;
        const label = m[0].startsWith('~') ? 'strikethrough' : m[0].length > 1 ? 'bold' : 'italic';
        found(
          base === undefined ? undefined : base + m.index,
          nearest,
          m[0].length,
          `\`${m[0]}\` is unpaired and will display verbatim to the reader (did you mean ${label}?)`,
          'Pair the markers; write \\* (\\_, \\~) for a literal character; put commands, paths and globs in backticks',
        );
      }
      for (const m of text.matchAll(/\$\$/g)) {
        if (escaped(text, m.index)) continue;
        found(
          base === undefined ? undefined : base + m.index,
          nearest,
          2,
          '`$$` was not parsed as math and will display verbatim to the reader',
          'If this site renders math, the delimiters failed to pair; if it does not, this formula will never render. Write \\$\\$ for literal characters',
        );
        break; // one report per node is enough
      }
    };

    const walk = (node: MdNode, parent: MdNode | null, index: number, nearest: Point): void => {
      const here = node.position?.start ?? nearest;

      if (node.type === 'text') {
        inspectText(node, here);
        return;
      }

      // MDX expressions: `{0,1,2,3}` in prose is valid JS and silently
      // evaluates to `3` — content vanishes without a sound. Outside comments
      // and template literals (inline-SVG styling and similar build-time
      // idioms), prose has no legitimate expression.
      if (node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression') {
        if (!isIntendedExpression(node.value ?? '')) {
          found(
            node.position?.start.offset,
            here,
            (node.position && node.position.end.offset! - node.position.start.offset!) || 1,
            `\`{${(node.value ?? '').slice(0, 40)}}\` is evaluated by MDX as a JS expression — this text will not appear on the page`,
            'Write literal braces as \\{…\\}; comments as {/* … */}',
          );
        }
      }

      // line-wrap swallowing: previous line is prose, next line starts with
      // `+`/`*` — the sentence tail becomes a bullet list. `-` is the normal
      // list marker and can't be told apart from a real list, so it's exempt.
      if (node.type === 'list' && parent && index > 0) {
        const prev = parent.children?.[index - 1];
        if (
          prev?.type === 'paragraph' &&
          prev.position &&
          node.position &&
          prev.position.end.line + 1 === node.position.start.line
        ) {
          const marker = source.slice(node.position.start.offset ?? 0).trimStart()[0];
          if (marker === '+' || marker === '*') {
            found(
              node.position.start.offset,
              here,
              1,
              `the leading \`${marker}\` turned this line into a bullet list (left behind by wrapping the previous line?)`,
              `Rejoin the previous line, or write \\${marker} for the literal character`,
            );
          }
        }
      }

      if (node.type === 'inlineMath' || node.type === 'math') {
        const raw = node.position ? source.slice(node.position.start.offset!, node.position.end.offset!) : '';
        // single-line `$$x$$`: remark-math silently treats it as inline math,
        // squeezing what should be a display formula into the line
        if (node.type === 'inlineMath' && raw.startsWith('$$')) {
          found(node.position?.start.offset, here, 2, 'single-line `$$…$$` is treated as small inline math, not a display block', 'Put each `$$` on its own line (three-line form)');
        }
        // HTML entities inside math: KaTeX renders `&lt;` as literal text
        if (/&(lt|gt|amp);/.test(node.value ?? '')) {
          found(node.position?.start.offset, here, 2, 'the formula contains an HTML entity like `&lt;` — KaTeX renders it as literal text inside the math', 'Write comparisons in math as \\lt \\gt \\le \\ge, and & as \\&');
        } else {
          // strict KaTeX test-render: production renders throwOnError:false,
          // so a broken macro ships as red text under a green build
          try {
            katex.renderToString(node.value ?? '', {
              displayMode: node.type === 'math',
              throwOnError: true,
              strict: 'ignore',
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/, '') : String(err);
            found(node.position?.start.offset, here, 2, `KaTeX cannot render this formula — the page would show red error text: ${reason.slice(0, 80)}`, 'Fix the formula itself');
          }
        }
      }

      // component props are plain strings: `$…$` / `**` in a non-whitelisted
      // prop displays verbatim
      if (options.renderedProps && (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement')) {
        const name = node.name ?? '';
        if (/^[A-Z]/.test(name)) {
          const allowed = options.renderedProps[name] ?? [];
          for (const attr of node.attributes ?? []) {
            if (attr.type !== 'mdxJsxAttribute' || typeof attr.value !== 'string') continue;
            if (allowed.includes(attr.name ?? '')) continue;
            if (!/\$[^$\n]+\$|\*\*/.test(attr.value)) continue;
            found(
              node.position?.start.offset,
              here,
              1,
              `the value of <${name} ${attr.name}=…> contains $…$ / ** — this prop does not render markdown/math, it will display verbatim`,
              'Use Unicode for math characters (α, Σ, ∞), or move the text into the prose',
            );
          }
        }
      }

      // hand-written numbers: this site's headings are auto-numbered at build
      // time, so a written one stacks into "5.1 1. Pillars"
      if (options.autoNumberedHeadings && node.type === 'heading') {
        const first = node.children?.find((c) => c.type === 'text');
        if (first && MANUAL_NUMBER.test(first.value ?? '')) {
          found(first.position?.start.offset, here, 2, 'the heading carries a hand-written number, which will stack with the build-time auto-number', 'Delete the hand-written number and let the build number it');
        }
      }

      node.children?.forEach((child, i) => walk(child, node, i, here));
    };
    walk(tree, null, -1, { line: 1, column: 1 });

    if (findings.length === 0) return;

    findings.sort((a, b) => a.line - b.line || a.column - b.column);
    const lines = source.split('\n');
    const where = file.path ?? '(markdown)';
    const report = findings.map(
      (f) =>
        `${where}:${f.line}:${f.column}  ${f.what}\n` +
        `${excerpt(lines[f.line - 1] ?? '', f.column, f.runLength)}\n` +
        `  → ${f.fix}`,
    );
    file.fail(`${findings.length} places in this Markdown will not display as written — stopping the build:\n\n${report.join('\n\n')}`);
  };
}
