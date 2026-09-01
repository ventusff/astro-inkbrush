/**
 * remarkFragmentDefinitions — for rendering a FRAGMENT of a note (the block
 * editor's live preview). A footnote definition that nothing in the
 * fragment references would render as nothing at all: remark-rehype lists
 * only referenced definitions, in the document's footnote section. It is
 * rendered in place instead — its content, led by its `[^label]` — so the
 * text being edited stays visible. A definition the fragment does reference
 * keeps the whole-document rendering.
 */

type Node = {
  type: string;
  identifier?: string;
  label?: string;
  value?: string;
  children?: Node[];
} & Record<string, unknown>;

function referencedIds(tree: Node): Set<string> {
  const ids = new Set<string>();
  const walk = (n: Node): void => {
    if (n.type === 'footnoteReference' && n.identifier) ids.add(n.identifier.toUpperCase());
    for (const child of n.children ?? []) walk(child);
  };
  walk(tree);
  return ids;
}

export function remarkFragmentDefinitions() {
  return (tree: Node): void => {
    const referenced = referencedIds(tree);
    const out: Node[] = [];
    for (const node of tree.children ?? []) {
      if (node.type !== 'footnoteDefinition' || referenced.has((node.identifier ?? '').toUpperCase())) {
        out.push(node);
        continue;
      }
      const label: Node = { type: 'inlineCode', value: `[^${node.label ?? node.identifier ?? ''}]` };
      const body = [...(node.children ?? [])];
      const first = body[0];
      if (first?.type === 'paragraph') {
        first.children = [label, { type: 'text', value: ' ' }, ...(first.children ?? [])];
      } else {
        body.unshift({ type: 'paragraph', children: [label] });
      }
      out.push(...body);
    }
    tree.children = out;
  };
}
