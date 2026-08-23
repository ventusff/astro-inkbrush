/**
 * The markdown → HTML render processor, assembled from explicit inputs — no
 * server config, no filesystem. The dev server's /render endpoint
 * (wiki/server/markdown.ts) and the browser-local playground build the same
 * pipeline through this one factory, so an edit previews identically in both.
 *
 * Two shapes, selected by `sanitize`:
 *  - false — the trusted author pipeline: dialect, the site's own plugins,
 *    wikilink resolution, raw HTML allowed;
 *  - true — the comment pipeline: dialect, math, GitHub sanitize schema
 *    (plus the class names remark-math emits, so rehype-katex still finds
 *    math nodes after sanitizing), never wikilinks, never raw HTML.
 *
 * Math follows the bare-vs-hooks rule: a site that declares no plugins at
 * all gets remark-math + rehype-katex; a site with hooks brings its own
 * math or has none.
 */
import type { Options as RemarkRehypeOptions } from 'remark-rehype';
import type { PluggableList, Processor } from 'unified';

import type { ContentGuardOptions } from './content-guard.ts';
import type { WikilinkResolver } from './wikilinks.ts';

export interface SitePluginSet {
  remarkPlugins?: PluggableList | undefined;
  rehypePlugins?: PluggableList | undefined;
  /** the site's remark-rehype bridge options, applied as in its build */
  remarkRehype?: RemarkRehypeOptions | undefined;
}

export interface RenderPipelineOptions {
  sanitize: boolean;
  site: SitePluginSet;
  /** wikilink resolution for the trusted pipeline (unused when sanitizing) */
  wikilinks?:
    | {
        resolve: WikilinkResolver;
        noteIdOf?: ((path: string | undefined) => string | undefined) | undefined;
      }
    | undefined;
}

export async function buildRenderProcessor(opts: RenderPipelineOptions): Promise<Processor> {
  const [
    { unified },
    remarkParse,
    { markdownSyntax },
    remarkMath,
    remarkRehype,
    rehypeSanitizeMod,
    rehypeKatex,
    rehypeStringify,
    { remarkWikilinks },
  ] = await Promise.all([
    import('unified'),
    import('remark-parse').then((m) => m.default),
    import('./markdown-syntax.ts'),
    import('remark-math').then((m) => m.default),
    import('remark-rehype').then((m) => m.default),
    import('rehype-sanitize'),
    import('rehype-katex').then((m) => m.default),
    import('rehype-stringify').then((m) => m.default),
    import('./wikilinks.ts'),
  ]);

  const { sanitize, site } = opts;
  const bare = site.remarkPlugins === undefined && site.rehypePlugins === undefined;
  const p = unified().use(remarkParse).use(markdownSyntax());

  if (sanitize) {
    p.use(remarkMath).use(remarkRehype);
  } else {
    if (bare) p.use(remarkMath);
    p.use(site.remarkPlugins ?? []);
    if (opts.wikilinks) {
      p.use(remarkWikilinks, {
        resolve: opts.wikilinks.resolve,
        ...(opts.wikilinks.noteIdOf ? { noteIdOf: opts.wikilinks.noteIdOf } : {}),
      });
    }
    // allowDangerousHtml stays on — trusted repo content
    p.use(remarkRehype, { ...site.remarkRehype, allowDangerousHtml: true });
    p.use(site.rehypePlugins ?? []);
    if (bare) p.use(rehypeKatex, { output: 'htmlAndMathml' });
  }

  if (sanitize) {
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

/**
 * Save-time validation of a note's full source, from explicit inputs — the
 * dev server's save gate (wiki/server/validate.ts) and the playground refuse
 * exactly the same input. Returns an error message, or null when `source`
 * passes. `path` becomes the vfile path (plugin messages, noteIdOf); the
 * caller resolves it.
 */
export interface ValidateSourceOptions {
  site: SitePluginSet;
  /** the site's content-guard options (renderedProps / autoNumberedHeadings) */
  guard?: ContentGuardOptions | undefined;
  /** compile as MDX (.mdx source) instead of the CommonMark reading */
  mdx: boolean;
  path?: string | undefined;
}

export async function validateNoteSource(
  source: string,
  opts: ValidateSourceOptions,
): Promise<string | null> {
  const [{ splitFrontmatter }, remarkMath, { markdownSyntax }, { remarkContentGuard }] =
    await Promise.all([
      import('./frontmatter.ts'),
      import('remark-math').then((m) => m.default),
      import('./markdown-syntax.ts'),
      import('./content-guard.ts'),
    ]);

  const fm = splitFrontmatter(source);
  if (fm.error) {
    return `frontmatter${fm.error.line ? ` (line ${fm.error.line})` : ''}: ${fm.error.message}`;
  }
  const site = opts.site;
  const bare = site.remarkPlugins === undefined && site.rehypePlugins === undefined;
  const remark: PluggableList = [
    ...markdownSyntax(),
    [remarkContentGuard, opts.guard ?? {}],
    ...(bare ? [remarkMath] : []),
    ...(site.remarkPlugins ?? []),
  ];
  const rehype = site.rehypePlugins ?? [];
  const body = fm.body;
  try {
    if (opts.mdx) {
      const { compile } = await import('@mdx-js/mdx');
      await compile(
        { value: body, ...(opts.path ? { path: opts.path } : {}) },
        { remarkPlugins: remark, rehypePlugins: rehype },
      );
    } else {
      const [{ unified }, remarkParse, remarkRehype, { VFile }] = await Promise.all([
        import('unified'),
        import('remark-parse').then((m) => m.default),
        import('remark-rehype').then((m) => m.default),
        import('vfile'),
      ]);
      // allowDangerousHtml stays on — the build pipeline handles raw HTML
      const processor = unified()
        .use(remarkParse)
        .use(remark)
        .use(remarkRehype, { ...site.remarkRehype, allowDangerousHtml: true })
        .use(rehype);
      const vfile = new VFile({ value: body, ...(opts.path ? { path: opts.path } : {}) });
      await processor.run(processor.parse(vfile), vfile);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
