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

import { buildRenderProcessor } from '../../lib/render-pipeline.ts';
import { buildWikilinkResolver, cachedScan } from '../../lib/wikilinks.ts';
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

/** the pipeline factory is lib/render-pipeline.ts (shared with the
 *  playground); this wrapper supplies the deployment-derived inputs */
async function buildProcessor(sanitize: boolean): Promise<Processor> {
  return buildRenderProcessor({
    sanitize,
    site: siteHooks(),
    ...(sanitize
      ? {}
      : {
          wikilinks: {
            resolve: buildWikilinkResolver({
              notes: cachedScan(contentRoot()),
              urlFor: noteUrl,
              locales: resolverLocales(),
            }),
            noteIdOf: noteIdOfPath,
          },
        }),
  });
}

export async function renderMarkdown(markdown: string, opts: RenderOptions): Promise<string> {
  if (opts.sanitize) sanitizing ??= await buildProcessor(true);
  else trusted ??= await buildProcessor(false);
  const processor = opts.sanitize ? sanitizing! : trusted!;
  const path = opts.note ? noteFile(opts.note)?.file : undefined;
  const file = await processor.process(path ? { value: markdown, path } : markdown);
  return String(file);
}
