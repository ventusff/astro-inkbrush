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
 * The inputs (the site's plugin graph and the wikilink resolver) come from
 * an async provider and are requested on the first render — never by
 * activation itself, which renders nothing on a clean page. Everything a
 * render needs beyond this module (the pipeline factory, unified and the
 * plugin graph, the block stamper) is a lazy chunk; warm() loads the preview
 * path ahead of the first edit.
 *
 * JSX follows the dev preview's boundary: it is not rendered as a component
 * (CommonMark reading — it lands as raw markup behind an anchor).
 */
import type { Processor } from 'unified';

import type { SitePluginSet } from '../../lib/render-pipeline.ts';
import type { WikilinkResolver } from '../../lib/wikilink-core.ts';

export interface RendererInputs {
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
  /** build the preview processor now (its chunks and the plugin graph) */
  warm(): Promise<void>;
}

export function createRenderer(inputs: () => Promise<RendererInputs>): PlaygroundRenderer {
  let previewProcessor: Promise<Processor> | null = null;
  let sourceProcessor: Promise<Processor> | null = null;

  const previewP = (): Promise<Processor> =>
    (previewProcessor ??= (async () => {
      const [{ buildRenderProcessor }, { site, wikilinks }] = await Promise.all([
        import('../../lib/render-pipeline.ts'),
        inputs(),
      ]);
      return buildRenderProcessor({
        sanitize: false,
        fragment: true,
        site,
        ...(wikilinks ? { wikilinks } : {}),
      });
    })());

  const sourceP = (): Promise<Processor> =>
    (sourceProcessor ??= (async () => {
      const [{ buildRenderProcessor }, { rehypeWikiBlocks }, { site, wikilinks }] = await Promise.all([
        import('../../lib/render-pipeline.ts'),
        import('../../lib/rehype-wiki-blocks.ts'),
        inputs(),
      ]);
      return buildRenderProcessor({
        sanitize: false,
        site: { ...site, rehypePlugins: [...(site.rehypePlugins ?? []), rehypeWikiBlocks] },
        ...(wikilinks ? { wikilinks } : {}),
      });
    })());

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
    warm: async () => {
      await previewP();
    },
  };
}
