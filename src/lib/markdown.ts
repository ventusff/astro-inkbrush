/**
 * markdownProcessor — one-line adoption for a site's `markdown.processor`
 * (subpath export astro-inkbrush/markdown):
 *
 *   markdown: { processor: markdownProcessor({ remarkPlugins, rehypePlugins }) }
 *
 * = Astro's unified processor + this CMS's Markdown dialect (markdownSyntax)
 * + the content guard (remarkContentGuard) + the site's own plugins. The
 * site's remark plugins run after the guard: the guard inspects the freshly
 * parsed tree, unaffected by transformers that rewrite text nodes later.
 *
 * Astro's built-in GFM is switched off here and re-mounted by the dialect
 * with `singleTilde: false`; with both in play, a single tilde would still
 * strike text through and quietly bypass the dialect's contract.
 */
import { type UnifiedProcessorOptions, unified } from '@astrojs/markdown-remark';

import { type ContentGuardOptions, remarkContentGuard } from './content-guard';
import { type MarkdownSyntax, markdownSyntax } from './markdown-syntax';

export { type ContentGuardOptions, type MarkdownSyntax, markdownSyntax, remarkContentGuard };

/** everything a site may pass: remark/rehype plugins, remark-rehype options,
 *  smartypants, guard options; GFM is owned by the dialect */
export type MarkdownProcessorOptions = Omit<UnifiedProcessorOptions, 'gfm'> & {
  guard?: ContentGuardOptions | undefined;
};

export function markdownProcessor(opts: MarkdownProcessorOptions = {}): ReturnType<typeof unified> {
  const { guard, ...rest } = opts;
  return unified({
    ...rest,
    gfm: false,
    remarkPlugins: [
      ...markdownSyntax(),
      [remarkContentGuard, guard ?? {}],
      ...(rest.remarkPlugins ?? []),
    ],
  });
}
