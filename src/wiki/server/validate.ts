/**
 * Save-time validation of a note's full source. The pipeline is the
 * dialect plus the site's own plugins — the same plugin sets the preview
 * renders with (./markdown.ts) — with two additions the page pipeline does
 * not have: the content guard (with the site's own guard options from the
 * hooks, so the save gate refuses exactly what the build refuses), and
 * (for .mdx) an MDX compile. Math
 * (remark-math) follows the same rule as the preview: mounted only when the
 * site hands over no plugins of its own — a site with hooks brings its own
 * math or has none. The frontmatter must parse as YAML. This approximates
 * the site's build with the plugins it declares to the integration; plugins
 * a site mounts elsewhere are outside it. A note that fails is refused
 * before any write.
 */
import { resolve } from 'node:path';

import type { PluggableList } from 'unified';

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { siteHooks } from './site.ts';
import { projectRoot } from './store.ts';

/** the frontmatter block blanked to spaces (lib/frontmatter.ts — line
 *  numbers and character offsets both preserved) */
export function withoutFrontmatter(source: string): string {
  return splitFrontmatter(source).body;
}

/** an error message, or null when `source` (of `file` — project-relative or
 *  absolute, judged by extension) passes; the absolute path is the vfile
 *  path, as in the build */
export async function validateSource(file: string, source: string): Promise<string | null> {
  const fm = splitFrontmatter(source);
  if (fm.error) {
    return `frontmatter${fm.error.line ? ` (line ${fm.error.line})` : ''}: ${fm.error.message}`;
  }
  const [remarkMath, { markdownSyntax }, { remarkContentGuard }] = await Promise.all([
    import('remark-math').then((m) => m.default),
    import('../../lib/markdown-syntax.ts'),
    import('../../lib/content-guard.ts'),
  ]);
  const site = siteHooks();
  // math follows the preview's bare-vs-hooks rule: a bare pipeline (no site
  // plugins at all) gets remark-math; a site with hooks brings its own
  const bare = site.remarkPlugins === undefined && site.rehypePlugins === undefined;
  const remark: PluggableList = [
    ...markdownSyntax(),
    [remarkContentGuard, site.guard ?? {}],
    ...(bare ? [remarkMath] : []),
    ...(site.remarkPlugins ?? []),
  ];
  const rehype = site.rehypePlugins ?? [];
  const body = fm.body;
  const path = resolve(projectRoot(), file);
  try {
    if (file.endsWith('.mdx')) {
      const { compile } = await import('@mdx-js/mdx');
      await compile({ value: body, path }, { remarkPlugins: remark, rehypePlugins: rehype });
    } else {
      const [{ unified }, remarkParse, remarkRehype, { VFile }] = await Promise.all([
        import('unified'),
        import('remark-parse').then((m) => m.default),
        import('remark-rehype').then((m) => m.default),
        import('vfile'),
      ]);
      // the site's remark-rehype bridge options apply as in its build;
      // allowDangerousHtml stays on — the build pipeline handles raw HTML
      const processor = unified()
        .use(remarkParse)
        .use(remark)
        .use(remarkRehype, { ...site.remarkRehype, allowDangerousHtml: true })
        .use(rehype);
      const vfile = new VFile({ value: body, path });
      await processor.run(processor.parse(vfile), vfile);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
