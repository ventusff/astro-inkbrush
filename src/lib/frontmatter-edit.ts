/**
 * setFrontmatterFields — a surgical edit of a note's top-level frontmatter
 * keys. The frontmatter block is text an author formatted by hand; a
 * rewrite through a YAML serializer would reflow every key. So a change
 * touches only the source range of the keys it names: each named key's
 * pair — from the start of its line through the end of its value, as the
 * yaml package's syntax tree delimits it — is replaced (or appended before
 * the closing fence when absent), a key set to `undefined` loses its pair,
 * and every other byte of the source — the other keys' formatting, the
 * comments between keys, the body, the line-break style — stays as it was.
 *
 * The block must be a block mapping (the shape of every note's
 * frontmatter); a flow mapping or a sequence at the top is refused, and
 * so is editing an explicit (`? key`) or complex key — only a plain
 * `key:` entry at the mapping's indentation is a span this editor knows.
 * After the edit the result is parsed again: every untouched key must
 * still carry its value and every named key its requested one (or be
 * gone), so an edit that would leave an alias without its anchor, or
 * otherwise change what the block says beyond the named keys, throws
 * instead of writing a broken note.
 *
 * A rendered value reads like the house style of hand-written frontmatter:
 * block maps, and flow lists (`[a, b]`) for sequences of scalars.
 */
import { Document, isMap, isScalar, parseDocument, visit } from 'yaml';

import { splitFrontmatter } from './frontmatter.ts';
import { stableJson } from './syndication-bundle.ts';

export interface SetFrontmatterOptions {
  /** keys (re)placed last, in this order, after every other edit */
  last?: readonly string[] | undefined;
}

/** [start, end) character offsets of a top-level pair in the YAML text */
interface PairSpan {
  start: number;
  end: number;
}

/** the top-level pairs of `raw` by key — a plain `key:` at the mapping's
 *  indentation; an explicit (`? key`) key is recorded as not editable —
 *  and the indentation the mapping sits at; throws unless the text is a
 *  block mapping (or empty) whose keys are all scalars */
function pairSpans(raw: string): { spans: Map<string, PairSpan | 'explicit'>; indent: string } {
  const doc = parseDocument(raw, { logLevel: 'silent' });
  const spans = new Map<string, PairSpan | 'explicit'>();
  const contents = doc.contents;
  if (contents === null || (raw.trim() === '' && !isMap(contents))) return { spans, indent: '' };
  if (!isMap(contents) || contents.flow) throw new Error('the frontmatter is not a block mapping');
  let indent = '';
  for (const pair of contents.items) {
    const key = pair.key;
    const keyRange = (key as { range?: [number, number, number] } | null)?.range;
    if (!keyRange) continue;
    if (!isScalar(key)) throw new Error('the frontmatter has a complex key (a sequence or mapping as key) — it cannot be edited surgically');
    const lineStart = raw.lastIndexOf('\n', keyRange[0] - 1) + 1;
    const before = raw.slice(lineStart, keyRange[0]);
    if (/\S/.test(before)) {
      spans.set(String(key.value), 'explicit');
      continue;
    }
    if (indent === '' && spans.size === 0) indent = before;
    const value = pair.value as { range?: [number, number, number] } | null;
    let end = value?.range ? value.range[2] : key.range[2];
    // a value that ends without its line break (`key:` alone) takes the break
    if (raw[end - 1] !== '\n' && end < raw.length) {
      const eol = raw.indexOf('\n', end);
      end = eol === -1 ? raw.length : eol + 1;
    }
    spans.set(String(key.value), { start: lineStart, end });
  }
  return { spans, indent };
}

/** `{ [key]: value }` as YAML text in house style: block maps, flow lists
 *  for sequences of scalars, no line folding; one line break per line */
function renderField(key: string, value: unknown, indent: string): string {
  const doc = new Document({ [key]: value });
  visit(doc, {
    Seq(_key, node) {
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
  });
  const text = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : indent + line))
    .join('\n');
}

/** the top-level values of a block, by key ({} for an unreadable block) */
function valuesOf(raw: string): Record<string, unknown> {
  const doc = parseDocument(raw, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`the edited frontmatter does not parse: ${doc.errors[0]!.message.split('\n')[0]}`);
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (err) {
    throw new Error(`the edited frontmatter does not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The source with the named top-level frontmatter fields set (`undefined`
 * deletes a field). Throws on a source without a frontmatter block, on a
 * block that does not parse or is not a block mapping, and on an edit
 * whose result would not parse or would change an untouched key's value.
 */
export function setFrontmatterFields(
  source: string,
  fields: Record<string, unknown>,
  options: SetFrontmatterOptions = {},
): string {
  const fm = splitFrontmatter(source);
  if (!fm.present) throw new Error('the note has no frontmatter block');
  if (fm.error) throw new Error(`the frontmatter does not parse: ${fm.error.message}`);

  const block = source.slice(fm.start, fm.end);
  const eol = /\r\n/.test(block) ? '\r\n' : '\n';
  // the closing fence is the block's last line; the YAML text ends where
  // the separator before it begins ('' for an empty block: `---\n---`)
  const closeStart = block.replace(/[ \t]*$/, '').length - 3;
  const rawEnd = closeStart - (fm.raw === '' ? 0 : eol.length);
  const openLength = rawEnd - fm.raw.length;

  const before = valuesOf(fm.raw.replace(/\r\n/g, '\n'));
  const last = options.last ?? [];
  const rank = (key: string): number => (last.includes(key) ? 1 + last.indexOf(key) : 0);
  const edits = Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b));

  // edited with LF line breaks; the source's own style is restored at the end
  let raw = fm.raw.replace(/\r\n/g, '\n');
  if (raw !== '' && !raw.endsWith('\n')) raw += '\n';
  for (const [key, value] of edits) {
    const { spans, indent } = pairSpans(raw);
    const span = spans.get(key);
    if (span === 'explicit') throw new Error(`'${key}' is an explicit or complex key — only plain \`key:\` entries are editable`);
    const rendered = value === undefined ? '' : renderField(key, value, indent);
    if (span && !last.includes(key)) raw = raw.slice(0, span.start) + rendered + raw.slice(span.end);
    else {
      if (span) raw = raw.slice(0, span.start) + raw.slice(span.end);
      raw += rendered;
    }
  }

  const after = valuesOf(raw);
  for (const key of Object.keys(before)) {
    if (key in fields) continue;
    if (!(key in after) || stableJson(after[key]) !== stableJson(before[key])) {
      throw new Error(`editing the frontmatter would change '${key}' as well — its value depends on an edited key`);
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined ? key in after : !(key in after) || stableJson(after[key]) !== stableJson(value)) {
      throw new Error(`'${key}' did not take the requested value`);
    }
  }

  raw = raw.replace(/\n$/, '').replace(/\n/g, eol);
  const separator = raw === '' ? '' : eol;
  return source.slice(0, fm.start + openLength) + raw + separator + source.slice(fm.start + closeStart);
}
