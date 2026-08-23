/**
 * Browser-side rendering for the playground — the same factory the dev
 * server's /render endpoint uses (lib/render-pipeline.ts), fed from explicit
 * site inputs instead of server config. Two products:
 *
 *  - preview(markdown):     the editor's live preview (trusted pipeline)
 *  - renderBlock(source):   an edited segment re-rendered for the page, its
 *                           top-level blocks stamped in CURRENT coordinates
 *                           (rehype-wiki-blocks runs on the fragment; the
 *                           fragment-relative stamps are shifted afterwards)
 *
 * JSX in a fragment follows the dev preview's boundary: it is not rendered
 * as a component (CommonMark reading — it lands as raw markup).
 */
import type { Processor } from 'unified';

import { rehypeWikiBlocks } from '../../lib/rehype-wiki-blocks.ts';
import {
  buildRenderProcessor,
  type SitePluginSet,
} from '../../lib/render-pipeline.ts';
import type { WikilinkResolver } from '../../lib/wikilinks.ts';

export interface RendererOptions {
  site: SitePluginSet;
  wikilinks?:
    | {
        resolve: WikilinkResolver;
        noteIdOf?: ((path: string | undefined) => string | undefined) | undefined;
      }
    | undefined;
}

export interface PlaygroundRenderer {
  preview(markdown: string, notePath?: string): Promise<string>;
  renderBlock(source: string, curStart: number, notePath?: string): Promise<string>;
}

export function createRenderer(opts: RendererOptions): PlaygroundRenderer {
  let previewProcessor: Promise<Processor> | null = null;
  let blockProcessor: Promise<Processor> | null = null;

  const previewP = (): Promise<Processor> =>
    (previewProcessor ??= buildRenderProcessor({
      sanitize: false,
      site: opts.site,
      ...(opts.wikilinks ? { wikilinks: opts.wikilinks } : {}),
    }));

  const blockP = (): Promise<Processor> =>
    (blockProcessor ??= buildRenderProcessor({
      sanitize: false,
      site: {
        ...opts.site,
        rehypePlugins: [...(opts.site.rehypePlugins ?? []), rehypeWikiBlocks],
      },
      ...(opts.wikilinks ? { wikilinks: opts.wikilinks } : {}),
    }));

  const run = async (p: Processor, markdown: string, notePath?: string): Promise<string> => {
    const file = await p.process(notePath ? { value: markdown, path: notePath } : markdown);
    return String(file);
  };

  return {
    preview: async (markdown, notePath) => run(await previewP(), markdown, notePath),
    renderBlock: async (source, curStart, notePath) => {
      const html = await run(await blockP(), source, notePath);
      const shift = curStart - 1;
      if (shift === 0) return html;
      return html.replace(
        /data-wiki-src="(\d+)-(\d+)"/g,
        (_m, a: string, b: string) => `data-wiki-src="${Number(a) + shift}-${Number(b) + shift}"`,
      );
    },
  };
}
