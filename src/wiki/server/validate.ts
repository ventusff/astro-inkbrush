/**
 * Save-time validation of a note's full source, the way the site renders it:
 * the frontmatter must parse as YAML, and the body runs the pipeline the
 * site builds with — the dialect, the content guard, the site's own remark
 * plugins, remark-rehype (raw HTML allowed, as in the build) and the site's
 * rehype plugins; an MDX file is compiled with the same plugin sets. A note
 * that passes here builds; one that fails is refused before any write.
 */
import { resolve } from 'node:path';

import { siteHooks } from './site.ts';
import { projectRoot } from './store.ts';

/** the frontmatter block replaced by blank lines (line numbers preserved) */
export function withoutFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---/, (m) => m.replace(/[^\n]+/g, ''));
}

/** YAML error of the frontmatter block, positioned in file lines; null when fine */
async function frontmatterProblem(source: string): Promise<string | null> {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!fm) return null;
  const { parseDocument } = await import('yaml');
  const bad = parseDocument(fm[1]!).errors[0];
  if (!bad) return null;
  // the block starts on file line 2, so block line n is file line n + 1
  const line = bad.linePos?.[0]?.line;
  const message = bad.message.split('\n')[0] ?? bad.message;
  return `frontmatter${line ? ` (line ${line + 1})` : ''}: ${message}`;
}

/** an error message, or null when `source` (of `file` — project-relative or
 *  absolute, judged by extension) builds; the absolute path is the vfile path, as in
 *  the build */
export async function validateSource(file: string, source: string): Promise<string | null> {
  const fmProblem = await frontmatterProblem(source);
  if (fmProblem) return fmProblem;
  const [remarkMath, { markdownSyntax }, { remarkContentGuard }] = await Promise.all([
    import('remark-math').then((m) => m.default),
    import('../../lib/markdown-syntax.ts'),
    import('../../lib/content-guard.ts'),
  ]);
  const site = siteHooks();
  const remark = [...markdownSyntax(), remarkContentGuard, remarkMath, ...(site.remarkPlugins ?? [])];
  const rehype = site.rehypePlugins ?? [];
  const body = withoutFrontmatter(source);
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
      const processor = unified()
        .use(remarkParse)
        .use(remark)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehype);
      const vfile = new VFile({ value: body, path });
      await processor.run(processor.parse(vfile), vfile);
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
