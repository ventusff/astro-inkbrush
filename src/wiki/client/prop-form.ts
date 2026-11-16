/**
 * A form for a component's parameters, beside its source in the block editor.
 *
 * A component declares the parameters an author sets by hand on its rendered
 * root element (or the one element in its block that declares them), as
 * `data-inkbrush-props`: a JSON array of `PropSpec`. The form shows one field
 * per parameter, read from the block's source: the attribute on the block's
 * first component tag. Changing a field rewrites that attribute in the source
 * (adding it when the tag has none), one change in the editor's history;
 * editing the source updates the fields. The source stays the one truth: the
 * form only reads and writes it.
 */
import type { EditorView } from '@codemirror/view';

import { h } from './ui';

/** one parameter a component declares for the form */
export interface PropSpec {
  /** the attribute's name on the component's tag */
  name: string;
  /** a number (written `{1.5}`), one of `choices` (written `"name"`), or free text */
  kind: 'number' | 'choice' | 'text';
  choices?: string[];
  min?: number;
  max?: number;
  step?: number;
}

/** the element of a block that declares its parameters: the block itself, or the one element inside it that does */
export function propsElement(block: HTMLElement): HTMLElement | null {
  if (block.matches('[data-inkbrush-props]')) return block;
  const inside = block.querySelectorAll<HTMLElement>('[data-inkbrush-props]');
  return inside.length === 1 ? inside[0]! : null;
}

/** the span of the first component tag in `source` (`<Name …>` or `<Name … />`), its end just before `>` or `/>` */
function firstTag(source: string): { start: number; end: number } | null {
  const open = /<[A-Z][\w.]*/.exec(source);
  if (!open) return null;
  let quote = '';
  let depth = 0;
  for (let i = open.index + open[0].length; i < source.length; i += 1) {
    const c = source[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return { start: open.index, end: source[i - 1] === '/' ? i - 1 : i };
  }
  return null;
}

/** the attribute `name` on the first component tag: where its value is and the value as text, or null */
function readAttribute(source: string, name: string): { from: number; to: number; value: string } | null {
  const tag = firstTag(source);
  if (!tag) return null;
  const text = source.slice(tag.start, tag.end);
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|\\{([^}]*)\\})`).exec(text);
  if (!match) return null;
  const from = tag.start + match.index + match[0].length - match[1]!.length;
  const braced = match[4]?.trim();
  const value = braced === undefined ? (match[2] ?? match[3] ?? '') : braced.replace(/^(["'`])(.*)\1$/, '$2');
  return { from, to: from + match[1]!.length, value };
}

/** `value` written as the attribute's value for its kind */
function literal(spec: PropSpec, value: string): string {
  if (spec.kind === 'number') return `{${Number(value)}}`;
  return value.includes('"') ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

/**
 * The form for `specs`, bound to `view`'s source. Returns the form element
 * and `sync`, which the editor calls when its source changed to bring the
 * fields to it.
 */
export function propForm(specs: PropSpec[], view: EditorView): { form: HTMLElement; sync(): void } {
  const fields = specs.map((spec) => {
    const input =
      spec.kind === 'choice'
        ? h('select', {}, ...(spec.choices ?? []).map((choice) => h('option', { value: choice }, choice)))
        : h('input', {
            type: spec.kind === 'number' ? 'number' : 'text',
            min: spec.min,
            max: spec.max,
            step: spec.step ?? (spec.kind === 'number' ? 'any' : undefined),
          });
    input.addEventListener('input', () => {
      const source = view.state.doc.toString();
      if (spec.kind === 'number' && !Number.isFinite(Number.parseFloat(input.value))) return;
      const at = readAttribute(source, spec.name);
      const text = literal(spec, input.value);
      if (at) view.dispatch({ changes: { from: at.from, to: at.to, insert: text } });
      else {
        const tag = firstTag(source);
        if (!tag) return;
        const end = source.slice(0, tag.end).trimEnd().length;
        view.dispatch({ changes: { from: end, insert: ` ${spec.name}=${text}` } });
      }
    });
    return { spec, input };
  });
  const form = h(
    'div',
    { class: 'wiki-editor-props' },
    ...fields.map(({ spec, input }) => h('label', {}, h('span', {}, spec.name), input)),
  );
  const sync = (): void => {
    const source = view.state.doc.toString();
    for (const { spec, input } of fields) {
      if (input === document.activeElement) continue;
      input.value = readAttribute(source, spec.name)?.value ?? '';
    }
  };
  sync();
  return { form, sync };
}
