/**
 * Browser-side rendering for the playground — the same factory the dev
 * server's /render endpoint uses (lib/render-pipeline.ts), fed from explicit
 * site inputs instead of server config. Two products:
 *
 *  - preview(markdown):            the editor's live preview (trusted
 *                                  pipeline, fragment reading)
 *  - renderSource(source, first):  a slice of the note's current source (an
 *                                  edited segment, or the whole body for the
 *                                  footnote section) rendered for the page,
 *                                  its blocks stamped in CURRENT coordinates:
 *                                  rehype-wiki-blocks runs on the value, and
 *                                  `first` — the current line its first line
 *                                  sits on — shifts the stamps
 *
 * JSX follows the dev preview's boundary: it is not rendered as a component
 * (CommonMark reading — it lands as raw markup behind an anchor).
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
  renderSource(source: string, first: number, notePath?: string): Promise<string>;
}

export function createRenderer(opts: RendererOptions): PlaygroundRenderer {
  let previewProcessor: Promise<Processor> | null = null;
  let sourceProcessor: Promise<Processor> | null = null;

  const previewP = (): Promise<Processor> =>
    (previewProcessor ??= buildRenderProcessor({
      sanitize: false,
      fragment: true,
      site: opts.site,
      ...(opts.wikilinks ? { wikilinks: opts.wikilinks } : {}),
    }));

  const sourceP = (): Promise<Processor> =>
    (sourceProcessor ??= buildRenderProcessor({
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
    renderSource: async (source, first, notePath) => {
      const html = await run(await sourceP(), source, notePath);
      const shift = first - 1;
      if (shift === 0) return html;
      return html.replace(
        /data-wiki-src="(\d+)-(\d+)"/g,
        (_m, a: string, b: string) => `data-wiki-src="${Number(a) + shift}-${Number(b) + shift}"`,
      );
    },
  };
}
