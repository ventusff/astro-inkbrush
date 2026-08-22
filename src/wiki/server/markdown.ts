/**
 * Shared markdown → HTML renderer (unified pipeline), used by
 *  - the block editor's live preview  (sanitize: false — trusted repo content)
 *  - comments                          (sanitize: true — user input)
 *
 * Parses the same dialect the site renders (lib/markdown-syntax), so the preview
 * shows what the page will show. Math renders through the site's KaTeX (the page
 * already ships katex CSS).
 */
import { join } from 'node:path';

import type { Processor } from 'unified';

import { buildWikilinkResolver, cachedScan, remarkWikilinks } from '../../lib/wikilinks';
import { wikiConfig } from './config';
import { projectRoot } from './store';

interface RenderOptions {
  sanitize: boolean;
  /** source note id (for locale-aware [[wikilink]] resolution; optional,
   *  passed by the preview caller) */
  note?: string;
}

let sanitizing: Processor | null = null;
let trusted: Processor | null = null;

async function buildProcessor(sanitize: boolean): Promise<Processor> {
  const [
    { unified },
    remarkParse,
    { markdownSyntax },
    remarkMath,
    remarkRehype,
    rehypeSanitizeMod,
    rehypeKatex,
    rehypeStringify,
  ] = await Promise.all([
    import('unified'),
    import('remark-parse').then((m) => m.default),
    import('../../lib/markdown-syntax'),
    import('remark-math').then((m) => m.default),
    import('remark-rehype').then((m) => m.default),
    import('rehype-sanitize'),
    import('rehype-katex').then((m) => m.default),
    import('rehype-stringify').then((m) => m.default),
  ]);

  const p = unified().use(remarkParse).use(markdownSyntax()).use(remarkMath);

  if (!sanitize) {
    // [[wikilink]] preview parity (trusted path only — comments are user
    // input and must not mint site-internal links). URLs are root-absolute
    // (/id/); a site mounted on a subpath covers this in dev via redirects.
    p.use(remarkWikilinks, {
      resolve: buildWikilinkResolver({
        notes: cachedScan(join(projectRoot(), wikiConfig().content.dir)),
        urlFor: (id) => `/${id}/`,
      }),
      noteIdOf: (path: string | undefined) => path, // renderMarkdown passes the note id as the vfile path
    });
  }

  p.use(remarkRehype, { allowDangerousHtml: !sanitize });

  if (sanitize) {
    // default GitHub schema + keep the class names remark-math emits so
    // rehype-katex (which runs after sanitize) can still find math nodes
    const schema = structuredClone(rehypeSanitizeMod.defaultSchema);
    schema.attributes ??= {};
    schema.attributes['code'] = [
      ...(schema.attributes['code'] ?? []),
      ['className', 'language-math', 'math-inline', 'math-display'],
    ];
    schema.attributes['mark'] = [];
    schema.tagNames = [...(schema.tagNames ?? []), 'mark'];
    p.use(rehypeSanitizeMod.default, schema);
  }

  p.use(rehypeKatex, { output: 'htmlAndMathml' }).use(rehypeStringify, {
    allowDangerousHtml: !sanitize,
  });
  return p as unknown as Processor;
}

export async function renderMarkdown(markdown: string, opts: RenderOptions): Promise<string> {
  if (opts.sanitize) sanitizing ??= await buildProcessor(true);
  else trusted ??= await buildProcessor(false);
  const processor = opts.sanitize ? sanitizing! : trusted!;
  const file = await processor.process(
    opts.note ? { value: markdown, path: opts.note } : markdown,
  );
  return String(file);
}
