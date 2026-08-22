/**
 * Save-time validation of a note's full source, the way the site renders it:
 * the dialect, the content guard, the site's own remark plugins (from
 * `inkbrush({ markdown })`); an MDX file is compiled as well. A note that
 * passes here builds; one that fails is refused before any write.
 */
import { resolve } from 'node:path';

import { siteHooks } from './site.ts';
import { projectRoot } from './store.ts';

/** the frontmatter block replaced by blank lines (line numbers preserved) */
export function withoutFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---/, (m) => m.replace(/[^\n]+/g, ''));
}

/** an error message, or null when `source` (of `file` — project-relative or
 *  absolute, judged by extension) builds; the absolute path is the vfile path, as in
 *  the build */
export async function validateSource(file: string, source: string): Promise<string | null> {
  const [remarkMath, { markdownSyntax }, { remarkContentGuard }] = await Promise.all([
    import('remark-math').then((m) => m.default),
    import('../../lib/markdown-syntax.ts'),
    import('../../lib/content-guard.ts'),
  ]);
  const remark = [...markdownSyntax(), remarkContentGuard, remarkMath, ...(siteHooks().remarkPlugins ?? [])];
  const body = withoutFrontmatter(source);
  const path = resolve(projectRoot(), file);
  try {
    if (file.endsWith('.mdx')) {
      const { compile } = await import('@mdx-js/mdx');
      await compile({ value: body, path }, { remarkPlugins: remark });
    } else {
      const [{ unified }, remarkParse, { VFile }] = await Promise.all([
        import('unified'),
        import('remark-parse').then((m) => m.default),
        import('vfile'),
      ]);
      const processor = unified().use(remarkParse).use(remark);
      const vfile = new VFile({ value: body, path });
      await processor.run(processor.parse(vfile), vfile);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
