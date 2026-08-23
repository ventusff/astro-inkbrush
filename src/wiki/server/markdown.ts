/**
 * Shared markdown → HTML renderer (unified pipeline), used by
 *  - the block editor's live preview  (sanitize: false — trusted repo content)
 *  - comments                          (sanitize: true — user input)
 *
 * The preview pipeline is the dialect (lib/markdown-syntax) followed by the
 * site's own remark and rehype plugins from `inkbrush({ markdown })` — the
 * plugins the site declares to the integration, which approximates its page
 * pipeline but is not it (plugins a site mounts elsewhere, and Astro's own
 * processing, are outside it; save-time validation adds the guard and an
 * MDX compile on the same plugin sets, see ./validate.ts). The note's file
 * is the vfile path. A `[[wikilink]]` the site's plugins leave untouched is
 * resolved afterwards with the package's own resolver and the site's URL
 * rule. A site that hands over no plugins gets the defaults of a bare
 * pipeline: math (remark-math + KaTeX) and wikilinks. Site components
 * (MDX JSX) are not rendered; they show as their source.
 *
 * Comments always render math and never resolve wikilinks (a comment must
 * not mint site-internal links).
 */
import { relative, sep } from 'node:path';
import type { Processor } from 'unified';

import { buildWikilinkResolver, cachedScan, remarkWikilinks } from '../../lib/wikilinks.ts';
import { wikiConfig } from './config.ts';
import { noteUrl, siteHooks } from './site.ts';
import { contentRoot, noteFile } from './source.ts';

/** the deployment's locale table in the resolver's shape */
function resolverLocales(): { code: string; prefix: string }[] {
  return wikiConfig().content.locales.map((l) => ({ code: l.code, prefix: l.prefix }));
}

interface RenderOptions {
  sanitize: boolean;
  /** the note the markdown belongs to; its file becomes the vfile path
   *  (locale-aware wikilink resolution, the site's own `noteIdOf`) */
  note?: string;
}

/** the note id of an absolute file path inside the content root */
function noteIdOfPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const rel = relative(contentRoot(), path).split(sep).join('/');
  const m = /^(.+)\/index\.mdx?$/.exec(rel);
  return m && !rel.startsWith('..') ? m[1] : undefined;
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
    import('../../lib/markdown-syntax.ts'),
    import('remark-math').then((m) => m.default),
    import('remark-rehype').then((m) => m.default),
    import('rehype-sanitize'),
    import('rehype-katex').then((m) => m.default),
    import('rehype-stringify').then((m) => m.default),
  ]);

  const site = siteHooks();
  const bare = site.remarkPlugins === undefined && site.rehypePlugins === undefined;
  const p = unified().use(remarkParse).use(markdownSyntax());

  if (sanitize) {
    p.use(remarkMath).use(remarkRehype);
  } else {
    if (bare) p.use(remarkMath);
    p.use(site.remarkPlugins ?? []);
    p.use(remarkWikilinks, {
      resolve: buildWikilinkResolver({
        notes: cachedScan(contentRoot()),
        urlFor: noteUrl,
        locales: resolverLocales(),
      }),
      noteIdOf: noteIdOfPath,
    });
    // the site's remark-rehype bridge options apply as in its build;
    // allowDangerousHtml stays on — trusted repo content
    p.use(remarkRehype, { ...site.remarkRehype, allowDangerousHtml: true });
    p.use(site.rehypePlugins ?? []);
    if (bare) p.use(rehypeKatex, { output: 'htmlAndMathml' });
  }

  if (sanitize) {
    // default GitHub schema + keep the class names remark-math emits so
    // rehype-katex (which runs after sanitize) can still find math nodes.
    // Raw HTML never reaches this pipeline (remark-rehype runs without
    // allowDangerousHtml), so the schema needs no extra tag names.
    const schema = structuredClone(rehypeSanitizeMod.defaultSchema);
    schema.attributes ??= {};
    schema.attributes['code'] = [
      ...(schema.attributes['code'] ?? []),
      ['className', 'language-math', 'math-inline', 'math-display'],
    ];
    p.use(rehypeSanitizeMod.default, schema).use(rehypeKatex, { output: 'htmlAndMathml' });
  }

  p.use(rehypeStringify, { allowDangerousHtml: !sanitize });
  return p as unknown as Processor;
}

export async function renderMarkdown(markdown: string, opts: RenderOptions): Promise<string> {
  if (opts.sanitize) sanitizing ??= await buildProcessor(true);
  else trusted ??= await buildProcessor(false);
  const processor = opts.sanitize ? sanitizing! : trusted!;
  const path = opts.note ? noteFile(opts.note)?.file : undefined;
  const file = await processor.process(path ? { value: markdown, path } : markdown);
  return String(file);
}
