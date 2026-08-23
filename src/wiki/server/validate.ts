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

import { splitFrontmatter } from '../../lib/frontmatter.ts';
import { validateNoteSource } from '../../lib/render-pipeline.ts';
import { siteHooks } from './site.ts';
import { projectRoot } from './store.ts';

/** the frontmatter block blanked to spaces (lib/frontmatter.ts — line
 *  numbers and character offsets both preserved) */
export function withoutFrontmatter(source: string): string {
  return splitFrontmatter(source).body;
}

/** an error message, or null when `source` (of `file` — project-relative or
 *  absolute, judged by extension) passes; the absolute path is the vfile
 *  path, as in the build. The pipeline itself is lib/render-pipeline.ts
 *  (shared with the playground); this wrapper supplies the deployment's
 *  hooks and resolves the path. */
export async function validateSource(file: string, source: string): Promise<string | null> {
  const site = siteHooks();
  return validateNoteSource(source, {
    site,
    guard: site.guard ?? {},
    mdx: file.endsWith('.mdx'),
    path: resolve(projectRoot(), file),
  });
}
