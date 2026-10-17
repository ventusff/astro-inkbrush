/**
 * code-comments — the comments of a code block that its language's lexis
 * proves to be comments. These are the parts of a code block the translation
 * sync service hands to translation; everything else in the block it copies
 * into every language as written, so the two readings must agree.
 *
 * One reader per language, each answering the positions of the comment text
 * (the comment marker excluded). A block the reader cannot read, or that uses
 * a form the reader does not handle, answers null: nothing in it is proven to
 * be a comment, and the whole block is code.
 *
 * - JavaScript family (js ts json jsx tsx …): acorn's tokenizer; a comment
 *   counts when the readings with and without JSX both see it (text inside
 *   JSX reads as a comment without JSX, a TypeScript type argument reads as a
 *   tag with it); jsx and tsx must read with JSX.
 * - Python: Python's lexis for strings (every prefix, single, double and
 *   triple quotes) and `#` comments; an f-string whose braces hold a quote or
 *   a `#` makes the block unread.
 * - Shell: single and double quotes, backslashes, `$(…)`, `${…}`, `$'…'` and
 *   backquotes; `#` starts a comment at the start of a word (after
 *   unescaped whitespace, a newline or one of `; & | ( ) < >`) outside quotes
 *   and expansions; `<<` (heredoc, here-string), a comment or `case` inside an
 *   expansion make the block unread.
 * - YAML: the comment tokens of the `yaml` package's syntax tree (a line
 *   starting with `#` inside a block scalar is string content).
 * - Line-oriented configs (ini toml conf ssh-config dotenv properties): whole
 *   line comments only, the first non-blank character being the marker; a
 *   line continuing the one before (trailing backslash) is not one, and an
 *   unclosed quote at the end of a line, or toml's `"""` and `'''`, make the
 *   block unread.
 *
 * A `#!` line at the very start (after blanks only) is the interpreter's path,
 * never a comment to translate, in every language; so are the directives
 * written for tools (encoding declarations, lint switches, type-checker
 * pragmas, triple-slash references — at the start of a comment or after its
 * text, see DIRECTIVE).
 *
 * Other languages (the C family, console, log …) have no reader: the whole
 * block is code.
 */
import * as acorn from 'acorn';
import jsx from 'acorn-jsx';
import { Parser as YamlParser } from 'yaml';

/** one comment: the position of its text in the code, [start, end) */
export interface Comment {
  start: number;
  end: number;
}

const JSX_PARSER = acorn.Parser.extend(jsx());

const JS = new Set(['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'json', 'jsonc']);
const JSX = new Set(['jsx', 'tsx']);
const PYTHON = new Set(['python', 'py']);
const SHELL = new Set(['bash', 'sh', 'shell', 'zsh', 'ksh']);
const YAML = new Set(['yaml', 'yml']);
/** line-oriented configs: language → the characters that open a whole-line comment */
const LINE_CONFIGS: Record<string, string> = {
  ini: ';#',
  dosini: ';#',
  toml: '#',
  conf: '#',
  'ssh-config': '#',
  sshconfig: '#',
  dotenv: '#',
  env: '#',
  properties: '#!',
};

/**
 * Directives written for tools: encoding declarations, lint and formatter
 * switches, type-checker pragmas, triple-slash references, coverage and
 * region markers. They are matched at the start of the comment and after
 * every `#` or `//` inside it (`# note # noqa` still carries `noqa`); such a
 * comment stays as written.
 */
const DIRECTIVE = /^[\s/*#!-]*(?:-\*-|vim?:|coding[:=]|eslint|prettier|tslint|biome-ignore|stylelint|jshint|@ts-|@jsx|@flow|@license|@preserve|<reference|<amd|istanbul|c8\s|v8\s|noqa|type:|pylint:|pyright:|mypy:|fmt:|isort:|ruff:|nosec|pragma|shellcheck|NOLINT|clang-format|#?(?:end)?region\b|@formatter)/i;

/**
 * The comments of `code` in `lang` that are proven comments and written for
 * people (not the leading `#!`, not a tool's directive); null when the
 * language has no reader or the reader cannot read the block.
 */
export function codeComments(code: string, lang: string): Comment[] | null {
  const comments = languageComments(code, lang.toLowerCase());
  if (comments === null) return null;
  const shebang = /^\s*#!/.exec(code);
  const after = shebang ? lineEnd(code, shebang[0].length) : -1;
  return comments.filter((c) => c.start > after && !code.slice(c.start, c.end).split(/#|\/\//).some((part) => DIRECTIVE.test(part)));
}

function languageComments(code: string, lang: string): Comment[] | null {
  if (JS.has(lang) || JSX.has(lang)) return jsComments(code, JSX.has(lang));
  if (PYTHON.has(lang)) return pythonComments(code);
  if (SHELL.has(lang)) return shellComments(code);
  if (YAML.has(lang)) return yamlComments(code);
  const markers = LINE_CONFIGS[lang];
  if (markers !== undefined) return lineComments(code, markers, lang === 'toml');
  return null;
}

/* ---------------- JavaScript ---------------- */

/** the comments of one reading; null when it does not read */
function jsReading(code: string, withJsx: boolean): Comment[] | null {
  const out: Comment[] = [];
  const options: acorn.Options = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    onComment: (block, _text, start, end) => out.push({ start: start + 2, end: block ? end - 2 : end }),
  };
  try {
    for (const _ of withJsx ? JSX_PARSER.tokenizer(code, options) : acorn.tokenizer(code, options));
  } catch {
    return null;
  }
  return out;
}

function jsComments(code: string, jsxOnly: boolean): Comment[] | null {
  const withJsx = jsReading(code, true);
  const plain = jsReading(code, false);
  if (withJsx === null) return jsxOnly ? null : plain;
  if (plain === null) return withJsx;
  const within = (c: Comment, others: readonly Comment[]): boolean => others.some((o) => o.start <= c.start && c.end <= o.end);
  const agreed = new Map<string, Comment>();
  for (const c of [...withJsx.filter((c) => within(c, plain)), ...plain.filter((c) => within(c, withJsx))]) agreed.set(`${c.start}:${c.end}`, c);
  return [...agreed.values()].sort((a, b) => a.start - b.start);
}

/* ---------------- Python ---------------- */

/** string prefixes: r u b f t and their two-letter combinations, any case */
const PY_PREFIX = /^(?:[rubft]|[rb][rbft]|[ft][rft])$/i;

function pythonComments(code: string): Comment[] | null {
  const out: Comment[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '#') {
      const end = lineEnd(code, i);
      out.push({ start: i + 1, end });
      i = end;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i;
      while (j < code.length && /[\p{L}\p{N}_]/u.test(code[j]!)) j++;
      const word = code.slice(i, j);
      if ((code[j] === '"' || code[j] === "'") && PY_PREFIX.test(word)) {
        const after = pythonString(code, j, /[ft]/i.test(word));
        if (after < 0) return null;
        i = after;
      } else i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const after = pythonString(code, i, false);
      if (after < 0) return null;
      i = after;
      continue;
    }
    i++;
  }
  return out;
}

/** read one Python string from its quote; the position after it, or -1 when it does not close or an f-string field is beyond the reader */
function pythonString(code: string, at: number, formatted: boolean): number {
  const q = code[at]!;
  const quote = code.startsWith(q.repeat(3), at) ? q.repeat(3) : q;
  let j = at + quote.length;
  while (j < code.length) {
    if (code.startsWith(quote, j)) return j + quote.length;
    const ch = code[j]!;
    if (ch === '\\') j += 2;
    else if (ch === '\n' && quote.length === 1) return -1;
    else if (formatted && ch === '{') {
      if (code[j + 1] === '{') j += 2;
      else {
        // a replacement field: read to its matching brace; a quote, comment marker or newline inside is beyond the reader
        let depth = 0;
        for (; j < code.length; j++) {
          const x = code[j]!;
          if (x === '"' || x === "'" || x === '#' || x === '\n' || x === '\\') return -1;
          if (x === '{') depth++;
          else if (x === '}' && --depth === 0) break;
        }
        j++;
      }
    } else j++;
  }
  return -1;
}

/* ---------------- Shell ---------------- */

/** the shell reader met a form it does not handle */
class Unsure extends Error {}

/** characters that separate words when unescaped: blanks and metacharacters */
const SHELL_BREAK = /[\s;&|()<>]/;

function shellComments(code: string): Comment[] | null {
  if (code.includes('<<')) return null;
  const out: Comment[] = [];
  try {
    let i = 0;
    /** the next character starts a word: at the start, or right after a separating character */
    let wordStart = true;
    while (i < code.length) {
      const c = code[i]!;
      if (c === '#' && wordStart) {
        const end = lineEnd(code, i);
        out.push({ start: i + 1, end });
        i = end;
        continue;
      }
      const next = shellStep(code, i);
      wordStart = next === i + 1 && SHELL_BREAK.test(c);
      i = next;
    }
  } catch (e) {
    if (e instanceof Unsure) return null;
    throw e;
  }
  return out;
}

/** read one unit at i (an escape, a quote, an expansion or one character); the position after it */
function shellStep(code: string, i: number): number {
  const c = code[i]!;
  if (c === '\\') return i + 2;
  if (c === "'") return closing(code, i + 1, "'");
  if (c === '"') return shellDouble(code, i + 1);
  if (c === '`') return shellBacktick(code, i + 1);
  if (c === '$') {
    const n = code[i + 1];
    if (n === '(') return shellParen(code, i + 2);
    if (n === '{') return shellBrace(code, i + 2);
    if (n === "'") return shellAnsi(code, i + 2);
  }
  return i + 1;
}

function closing(code: string, from: number, quote: string): number {
  const j = code.indexOf(quote, from);
  if (j < 0) throw new Unsure();
  return j + 1;
}

function shellDouble(code: string, from: number): number {
  let i = from;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '"') return i + 1;
    if (c === '\\') i += 2;
    else if (c === '`' || (c === '$' && (code[i + 1] === '(' || code[i + 1] === '{'))) i = shellStep(code, i);
    else i++;
  }
  throw new Unsure();
}

function shellBacktick(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === '`') return i + 1;
  }
  throw new Unsure();
}

function shellAnsi(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === "'") return i + 1;
  }
  throw new Unsure();
}

/** `$(…)` and `$((…))`: read past the matching parenthesis; `#` or `case` at the start of a word inside is beyond the reader */
function shellParen(code: string, from: number): number {
  let depth = 1;
  let i = from;
  let wordStart = true;
  while (i < code.length) {
    const c = code[i]!;
    if (wordStart && (c === '#' || /^case\b/.test(code.slice(i, i + 5)))) throw new Unsure();
    if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      if (--depth === 0) return i + 1;
      i++;
    } else {
      const next = shellStep(code, i);
      wordStart = next === i + 1 && SHELL_BREAK.test(c);
      i = next;
      continue;
    }
    wordStart = true;
  }
  throw new Unsure();
}

/** `${…}`: read past the matching brace */
function shellBrace(code: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      if (--depth === 0) return i + 1;
      i++;
    } else i = shellStep(code, i);
  }
  throw new Unsure();
}

/* ---------------- YAML ---------------- */

function yamlComments(code: string): Comment[] | null {
  const out: Comment[] = [];
  let broken = false;
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (x === null || typeof x !== 'object') return;
    const t = x as { type?: string; offset?: number; source?: string };
    if (t.type === 'error') broken = true;
    if (t.type === 'comment' && typeof t.offset === 'number' && typeof t.source === 'string') out.push({ start: t.offset + 1, end: t.offset + t.source.length });
    for (const v of Object.values(x)) visit(v);
  };
  try {
    for (const token of new YamlParser().parse(code)) visit(token);
  } catch {
    return null;
  }
  return broken ? null : out.sort((a, b) => a.start - b.start);
}

/* ---------------- line-oriented configs ---------------- */

function lineComments(code: string, markers: string, toml: boolean): Comment[] | null {
  if (toml && (code.includes('"""') || code.includes("'''"))) return null;
  const out: Comment[] = [];
  let continued = false;
  let at = 0;
  for (const line of code.split('\n')) {
    const lead = /^[ \t]*/.exec(line)![0].length;
    if (!continued && markers.includes(line[lead] ?? '')) out.push({ start: at + lead + 1, end: at + line.length });
    else {
      if (openQuote(line)) return null;
      continued = /(?:^|[^\\])(?:\\\\)*\\\s*$/.test(line);
    }
    at += line.length + 1;
  }
  return out;
}

/** a single, double or back quote still open at the end of the line (a backslash escapes the next character inside double quotes) */
function openQuote(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === null) {
      if (c === '"' || c === "'" || c === '`') quote = c;
    } else if (c === '\\' && quote === '"') i++;
    else if (c === quote) quote = null;
  }
  return quote !== null;
}

const lineEnd = (code: string, i: number): number => {
  const nl = code.indexOf('\n', i);
  return nl < 0 ? code.length : nl;
};
