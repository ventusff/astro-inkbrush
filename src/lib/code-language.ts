/**
 * code-language — a page's code is the same in every language.
 *
 * The translation sync service translates the words of a page written for
 * readers: its prose, the comments in its code blocks, a code block that
 * holds text (```text, ```markdown …), and the plain strings its script and
 * components hold under reader-facing keys and attributes (`label: '…'`,
 * `title="…"`, in MDX components and raw HTML alike). Everything else — the
 * script itself, every other attribute, `<script>` and `<style>` elements,
 * inline code, the code of a code block — it copies from the source page into
 * every other language as written. Chinese in one of those
 * places therefore reaches the English and German readers as Chinese.
 *
 * codeLanguageFindings() walks a page's parsed tree (remark, with remark-mdx
 * for MDX) together with its source: each node of code gives the source ranges
 * the service copies — the node less the parts it translates — and every line
 * of such a range that holds Chinese is a finding. remarkCodeLanguage()
 * records them on the file as `file.data.codeLanguage`. The check reads a page of the source language —
 * the copies follow it. A word a reader sees belongs in prose, under a
 * reader-facing key or attribute, or in the site's text catalogs; a
 * placeholder in code is an English word the prose explains (`<run-id>`).
 *
 * Every place reports as a warning — listed, never failing the content check —
 * unless the site raises it: its page-pipeline module (the `--config` of
 * check-content and check-language) exports `codeLanguage`, `'error'` for
 * every place or an object naming places (`{ script: 'error' }`), read by
 * codeLanguageSeverity().
 */
import { decodeNamedCharacterReference } from 'decode-named-character-reference';

import { codeComments } from './code-comments.ts';

/** where in a page the Chinese sits */
export type CodePlace = 'script' | 'attribute' | 'code-block' | 'inline-code';

export type Severity = 'error' | 'warning';

const PLACES: readonly CodePlace[] = ['script', 'attribute', 'code-block', 'inline-code'];

/** How each place counts in a site that sets nothing: a warning, listed and passing. */
export const CODE_LANGUAGE_SEVERITY: Readonly<Record<CodePlace, Severity>> = {
  script: 'warning',
  attribute: 'warning',
  'code-block': 'warning',
  'inline-code': 'warning',
};

/**
 * A site's `codeLanguage` setting as a severity per place: absent is the
 * default, `'error'` or `'warning'` sets every place, an object sets the
 * places it names (`{ script: 'error', attribute: 'error' }`). Anything else
 * throws, naming what is accepted.
 */
export function codeLanguageSeverity(setting: unknown): Record<CodePlace, Severity> {
  const out = { ...CODE_LANGUAGE_SEVERITY };
  const isSeverity = (v: unknown): v is Severity => v === 'error' || v === 'warning';
  if (setting === undefined) return out;
  if (isSeverity(setting)) {
    for (const p of PLACES) out[p] = setting;
    return out;
  }
  const proto = setting !== null && typeof setting === 'object' ? Object.getPrototypeOf(setting) : undefined;
  if (proto === Object.prototype || proto === null) {
    for (const [place, value] of Object.entries(setting as object)) {
      if (!PLACES.includes(place as CodePlace) || !isSeverity(value)) {
        throw new Error(`codeLanguage.${place} = ${JSON.stringify(value)}: the places are ${PLACES.join(', ')}, each 'error' or 'warning'`);
      }
      out[place as CodePlace] = value;
    }
    return out;
  }
  throw new Error(`codeLanguage = ${JSON.stringify(setting)}: 'error', 'warning', or an object of places (${PLACES.join(', ')}) set to 'error' or 'warning'`);
}

export interface CodeLanguageFinding {
  place: CodePlace;
  severity: Severity;
  line: number;
  column: number;
  /** the attribute's name, or the code block's language */
  name?: string | undefined;
  /** the source line holding the Chinese, trimmed and cut to 100 characters */
  text: string;
  /** what is wrong and what to write instead */
  message: string;
}

const HAN = /\p{Script=Han}/u;

/**
 * The keys and attributes whose plain string values the sync service hands to
 * translation; a value under any other name is copied as written. A name is
 * here only when every site's components use it for display alone.
 */
export const READABLE_KEYS: ReadonlySet<string> = new Set([
  'title', 'label', 'lines', 'sub', 'tag', 'text', 'name', 'tip', 'note', 'group', 'value', 'alt', 'categories', 'colorName', 'wire',
]);
export const READABLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alt', 'title', 'toc', 'label', 'caption', 'description', 'note', 'kicker', 'meta', 'full', 'alias', 'num', 'count', 'placeholder',
  'tocLabel', 'rowLabel', 'colLabel', 'rowTitle', 'xLabel', 'yLabel', 'xlabel', 'ylabel', 'pointsLabel', 'correctLabel', 'selectLabel',
  'downloadLabel', 'instruction', 'failed', 'toggle', 'socketTitle', 'plugTitle', 'socketNote', 'plugNote', 'rail', 'zero',
  'categories', 'series', 'rows', 'cols', 'titles', 'segmentLabels',
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'aria-placeholder', 'data-tip', 'data-alt', 'data-tooltip',
]);

/** code-block languages whose whole content the service translates as text */
const TEXT_FENCES: ReadonlySet<string> = new Set(['text', 'txt', 'plain', 'plaintext', 'markdown', 'md', 'mdx']);

interface Point {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface Position {
  start: Point;
  end: Point;
}

/** the slice of an estree node the walk reads; offsets are the page source's */
interface EsNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

interface MdAttribute {
  type: string;
  name?: string | undefined;
  value?: string | { type: string; value?: string; data?: { estree?: EsNode | null | undefined } } | null | undefined;
  data?: { estree?: EsNode | null | undefined } | undefined;
  position?: Position | undefined;
}

interface MdNode {
  type: string;
  value?: string | undefined;
  lang?: string | null | undefined;
  attributes?: MdAttribute[] | undefined;
  children?: MdNode[] | undefined;
  position?: Position | undefined;
  /** structurally open so MdNode stays a supertype of every pipeline's Root */
  data?: unknown;
}

/** a stretch of the page source the service copies as written */
interface Copied {
  start: number;
  end: number;
  place: CodePlace;
  name?: string | undefined;
  /** an attribute value: it reads as its character references decode */
  decode?: boolean;
}

function message(place: CodePlace, name: string | undefined): string {
  switch (place) {
    case 'script':
      return 'Chinese in the page\'s script';
    case 'attribute':
      return name === '{...}' ? 'Chinese in a spread attribute' : `Chinese in the attribute \`${name}\``;
    case 'code-block':
      return `Chinese in ${name ? `a ${name}` : 'a'} code block outside its comments`;
    case 'inline-code':
      return 'Chinese in inline code';
  }
}

/** what to write instead, one line per place */
export const CODE_LANGUAGE_ADVICE: Readonly<Record<CodePlace, string>> = {
  script:
    'a script: the words a script writes come from the site\'s text catalogs, read in the page\'s language; a plain string a reader sees sits under a key the service translates (READABLE_KEYS)',
  attribute:
    'an attribute: words for the reader go through an attribute the service translates (READABLE_ATTRIBUTES), or come from the site\'s text catalogs',
  'code-block':
    'a code block: placeholders are English words (`<run-id>`) the prose explains; words for the reader go in a comment (in js, ts, python, sh, yaml, toml and the other languages code-comments.ts reads) or in a `text` block',
  'inline-code': 'inline code: a placeholder is an English word (`<run-id>`) the prose explains',
};

/** an attribute value as the browser reads it: character references decoded */
function decodeReferences(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return decodeNamedCharacterReference(ref) || whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** a key or attribute name: identifier, string, `a:b` */
function nameOf(node: unknown): string | null {
  const n = node as EsNode | null | undefined;
  if (n?.type === 'Identifier' || n?.type === 'JSXIdentifier') return n['name'] as string;
  if (n?.type === 'Literal' && typeof n['value'] === 'string') return n['value'];
  if (n?.type === 'JSXNamespacedName') return `${nameOf(n['namespace'])}:${nameOf(n['name'])}`;
  return null;
}

/**
 * A string at this place is reader text the service translates: the value (or
 * an array element of the value) of an object property under a readable key,
 * or of a readable JSX attribute, written directly or in braces. `attribute`
 * names the component attribute the whole expression is the value of.
 */
function readable(node: EsNode, path: readonly EsNode[], attribute: string | null): boolean {
  let child = node;
  let k = path.length - 1;
  while (k >= 0 && path[k]!.type === 'ArrayExpression') child = path[k--]!;
  const parent = path[k];
  if (parent === undefined) return attribute !== null && READABLE_ATTRIBUTES.has(attribute);
  if (parent.type === 'Property') {
    const key = parent['computed'] ? null : nameOf(parent['key']);
    return parent['value'] === child && parent['kind'] === 'init' && !parent['method'] && path[k - 1]?.type === 'ObjectExpression' && key !== null && READABLE_KEYS.has(key);
  }
  const owner = parent.type === 'JSXExpressionContainer' ? path[k - 1] : parent;
  if (owner?.type !== 'JSXAttribute' || (parent.type === 'JSXAttribute' && parent['value'] !== child)) return false;
  const name = nameOf(owner['name']);
  return name !== null && READABLE_ATTRIBUTES.has(name);
}

/**
 * The string literals of a script the service translates, as source ranges:
 * plain strings and templates without `${}` (untagged) at a readable place.
 * `as` says what the program is: module code, an expression (`attribute`
 * names the attribute it is the value of, if any), or a spread attribute,
 * which the service copies whole.
 */
function translatedLiterals(root: EsNode, as: 'module' | 'expression' | 'spread', attribute: string | null): [number, number][] {
  if (as === 'spread') return [];
  const out: [number, number][] = [];
  const path: EsNode[] = [];
  const step = (node: EsNode): void => {
    const plain =
      (node.type === 'Literal' && typeof node['value'] === 'string') ||
      (node.type === 'TemplateLiteral' && (node['expressions'] as unknown[]).length === 0 && path.at(-1)?.type !== 'TaggedTemplateExpression');
    if (plain && node.start !== undefined && node.end !== undefined && readable(node, path, attribute)) out.push([node.start, node.end]);
    path.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range' || key === 'comments') continue;
      if (Array.isArray(value)) {
        for (const x of value) if (x && typeof (x as EsNode).type === 'string') step(x as EsNode);
      } else if (value && typeof (value as EsNode).type === 'string') step(value as EsNode);
    }
    path.pop();
  };
  if (as === 'module') step(root);
  else for (const statement of (root['body'] as EsNode[] | undefined) ?? []) if (statement['expression']) step(statement['expression'] as EsNode);
  return out;
}

/** [start, end) less the ranges in `holes`, as stretches of one place */
function less(start: number, end: number, holes: readonly (readonly [number, number])[], place: CodePlace, name?: string): Copied[] {
  const out: Copied[] = [];
  let at = start;
  for (const [a, b] of [...holes].sort((x, y) => x[0] - y[0])) {
    if (a > at) out.push({ start: at, end: Math.min(a, end), place, name });
    at = Math.max(at, b);
  }
  if (at < end) out.push({ start: at, end, place, name });
  return out;
}

/** an expression that is one block comment, `{/* … *\/}`: the service translates the comment */
const commentExpression = (text: string): boolean => {
  const m = /^\{\s*\/\*([\s\S]*)\*\/\s*\}$/.exec(text);
  return m !== null && !m[1]!.includes('*/');
};

/**
 * HTML attributes from `i` up to the tag's end `stop` (`>` of a tag, `}` of a
 * heading anchor), read the way HTML reads them: the name runs to a blank,
 * `/`, `>` or `=`; after `=` comes a quoted value or a bare one. null when a
 * quote does not close or the tag does not end before `limit`.
 */
function attributeList(text: string, i: number, limit: number, stop: string): { attributes: { name: string; start: number; end: number; quoted: boolean }[]; end: number } | null {
  const attributes: { name: string; start: number; end: number; quoted: boolean }[] = [];
  const space = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  for (;;) {
    while (i < limit && (space(text[i]) || text[i] === '/')) i++;
    if (i >= limit) return null;
    if (text[i] === stop) return { attributes, end: i };
    const nameAt = i;
    while (i < limit && !space(text[i]) && !'/>='.includes(text[i]!) && text[i] !== stop) i++;
    if (i === nameAt) i++;
    const name = text.slice(nameAt, i);
    let j = i;
    while (j < limit && space(text[j])) j++;
    if (text[j] !== '=') continue;
    j++;
    while (j < limit && space(text[j])) j++;
    const q = text[j];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, j + 1);
      if (close < 0 || close >= limit) return null;
      attributes.push({ name, start: j + 1, end: close, quoted: true });
      i = close + 1;
    } else {
      let v = j;
      while (v < limit && !space(text[v]) && text[v] !== '>' && text[v] !== stop) v++;
      attributes.push({ name, start: j, end: v, quoted: false });
      i = v;
    }
  }
}

/**
 * The copied stretches of raw HTML in a Markdown page, [from, to) of `text`:
 * the value of an attribute not in READABLE_ATTRIBUTES (or unquoted), the
 * whole of a `<script>` or `<style>` element, an unclosed `<!--` and a
 * declaration (`<!DOCTYPE …>`). Text between tags and a closed comment are
 * translated.
 */
function htmlCopied(text: string, from: number, to: number): Copied[] {
  const out: Copied[] = [];
  let i = from;
  while (i < to) {
    const lt = text.indexOf('<', i);
    if (lt < 0 || lt >= to) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0 || close + 3 > to) {
        out.push({ start: lt, end: to, place: 'script' });
        break;
      }
      i = close + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      const close = text.indexOf('>', lt);
      const end = close < 0 || close >= to ? to : close + 1;
      out.push({ start: lt, end, place: 'script' });
      i = end;
      continue;
    }
    const tag = /^<\/?[A-Za-z][^\s/>]*/.exec(text.slice(lt, Math.min(to, lt + 256)));
    if (!tag) {
      i = lt + 1;
      continue;
    }
    const list = attributeList(text, lt + tag[0].length, to, '>');
    if (list === null) {
      i = lt + 1;
      continue;
    }
    const raw = /^<(script|style)\b/i.exec(tag[0]);
    if (raw) {
      const close = text.toLowerCase().indexOf(`</${raw[1]!.toLowerCase()}`, list.end);
      const gt = close < 0 || close >= to ? -1 : text.indexOf('>', close);
      const end = gt < 0 || gt >= to ? to : gt + 1;
      out.push({ start: lt, end, place: 'script' });
      i = end;
      continue;
    }
    for (const a of list.attributes) {
      if (!(a.quoted && READABLE_ATTRIBUTES.has(a.name))) out.push({ start: a.start, end: a.end, place: 'attribute', name: a.name, decode: true });
    }
    i = list.end + 1;
  }
  return out;
}

/** the copied stretches of one node of the page, from its source */
function copiedOf(node: MdNode, source: string): Copied[] {
  const a = node.position?.start.offset;
  const b = node.position?.end.offset;
  if (a === undefined || b === undefined) return [];
  const estreeOf = (holder: { data?: unknown } | null | undefined): EsNode | null =>
    ((holder?.data as { estree?: EsNode | null } | undefined)?.estree ?? null);
  switch (node.type) {
    case 'mdxjsEsm':
    case 'mdxFlowExpression':
    case 'mdxTextExpression': {
      const module = node.type === 'mdxjsEsm';
      if (!module && commentExpression(source.slice(a, b))) return [];
      const program = estreeOf(node);
      return less(a, b, program ? translatedLiterals(program, module ? 'module' : 'expression', null) : [], 'script');
    }
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return (node.attributes ?? []).flatMap((attr): Copied[] => {
        const s = attr.position?.start.offset;
        const e = attr.position?.end.offset;
        if (s === undefined || e === undefined) return [];
        if (attr.type === 'mdxJsxExpressionAttribute') return [{ start: s, end: e, place: 'attribute', name: '{...}' }];
        const name = attr.name ?? '';
        if (attr.value === null || attr.value === undefined) return [];
        if (typeof attr.value === 'string') return READABLE_ATTRIBUTES.has(name) ? [] : [{ start: s, end: e, place: 'attribute', name, decode: true }];
        const program = estreeOf(attr.value);
        return less(s, e, program ? translatedLiterals(program, 'expression', name) : [], 'attribute', name);
      });
    case 'inlineCode': {
      // a heading anchor `{#id toc="…"}`: the service translates its readable attribute values
      const src = source.slice(a, b);
      const anchor = /^(`+)\s*\{#[^\s}]*/.exec(src);
      const list = anchor && /\}\s*`+$/.test(src) ? attributeList(source, a + anchor[0].length, b, '}') : null;
      const holes = (list?.attributes ?? []).filter((x) => x.quoted && READABLE_ATTRIBUTES.has(x.name)).map((x) => [x.start, x.end] as [number, number]);
      return less(a, b, holes, 'inline-code');
    }
    case 'code': {
      // a fence the service reads: an opening and a closing fence line, and a language; anything else it copies whole
      const src = source.slice(a, b);
      const lang = (node.lang ?? '').toLowerCase();
      const firstLine = src.indexOf('\n');
      const lastLine = src.lastIndexOf('\n');
      const fenced = /^ {0,3}(`{3,}|~{3,})/.test(src) && firstLine >= 0 && lastLine > firstLine && /^\s*(`{3,}|~{3,})\s*$/.test(src.slice(lastLine + 1));
      if (!fenced || lang === '') return [{ start: a, end: b, place: 'code-block', name: lang || undefined }];
      if (TEXT_FENCES.has(lang)) return [];
      const [from, to] = [a + firstLine + 1, a + lastLine];
      const comments = (codeComments(source.slice(from, to), lang) ?? []).map((c) => [from + c.start, from + c.end] as [number, number]);
      return less(from, to, comments, 'code-block', lang);
    }
    case 'html':
      return htmlCopied(source, a, b);
  }
  return [];
}

/**
 * Every place in a parsed page where Chinese sits in code the sync service
 * copies, in document order, each with its place's severity.
 */
export function codeLanguageFindings(tree: MdNode, source: string, severity: Readonly<Record<CodePlace, Severity>> = CODE_LANGUAGE_SEVERITY): CodeLanguageFinding[] {
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const out: CodeLanguageFinding[] = [];
  const seen = new Set<string>();
  const report = (c: Copied): void => {
    const raw = source.slice(c.start, c.end);
    if (!HAN.test(c.decode ? decodeReferences(raw) : raw)) return;
    // one finding per source line the stretch puts Chinese on; a value whose Chinese is all character references reads at its start
    const hits = [...raw.matchAll(/\p{Script=Han}/gu)].map((m) => c.start + m.index);
    for (const offset of hits.length > 0 ? hits : [c.start]) {
      const line = lineOf(offset);
      const key = `${c.place}:${c.name ?? ''}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lineEnd = source.indexOf('\n', lineStarts[line]!);
      const text = source.slice(lineStarts[line], lineEnd < 0 ? source.length : lineEnd).trim().slice(0, 100);
      out.push({ place: c.place, severity: severity[c.place], line: line + 1, column: offset - lineStarts[line]! + 1, name: c.name, text, message: message(c.place, c.name) });
    }
  };
  const walk = (node: MdNode): void => {
    for (const c of copiedOf(node, source)) report(c);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out.sort((x, y) => x.line - y.line || x.column - y.column);
}

/** a remark plugin recording codeLanguageFindings() on the file as `file.data.codeLanguage` */
export function remarkCodeLanguage(options: { severity?: Readonly<Record<CodePlace, Severity>> | undefined } = {}) {
  return (tree: MdNode, file: { value: unknown; data: Record<string, unknown> }): void => {
    file.data['codeLanguage'] = codeLanguageFindings(tree, String(file.value), options.severity);
  };
}

