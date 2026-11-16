/**
 * The dev server's renderer of a block of an MDX note. The block's
 * source, behind the note's own import and export statements, is handed to
 * Vite as an MDX module in the note's own directory, so the note's relative
 * imports and images resolve as they do in the note and the site's MDX
 * pipeline compiles it as it compiles the note; Astro's container renders
 * the module's content as the page at `page` would, in that page's locale.
 *
 * Each note directory has one such module, invalidated before every render;
 * renders run one at a time, so a module's text is the one its render asked
 * for. The module exists only in memory: no file is written, so nothing the
 * dev server watches changes.
 */
import { dirname, join } from 'node:path';

import type { AstroConfig } from 'astro';
import type { AstroContainerUserConfig, experimental_AstroContainer } from 'astro/container';
import type { Plugin, ViteDevServer } from 'vite';

/** the file name of a note directory's block module */
const BLOCK_MODULE = '__inkbrush_block_preview__.mdx';

/** absolute module id → the module's MDX text */
const blockModules = new Map<string, string>();

/** the Vite plugin answering the block modules' ids with their text, ahead of the file system */
export function blockModulePlugin(): Plugin {
  return {
    name: 'astro-inkbrush:block-module',
    enforce: 'pre',
    resolveId(id) {
      return blockModules.has(id) ? id : undefined;
    },
    load(id) {
      return blockModules.get(id);
    },
  };
}

/** renders `module` (MDX text) as a block of the note in `noteFile` (absolute path) on the page at `page` (its URL) */
export type BlockRenderer = (noteFile: string, module: string, page: string) => Promise<string>;

/**
 * The renderer of block modules on `server`. The container is the one
 * Vite loads, so the components it renders and the runtime it renders them
 * with are the same instances the pages use; it carries the site's
 * routing settings (`config`), from which a page's locale follows.
 */
export function createBlockRenderer(server: ViteDevServer, config: AstroConfig): BlockRenderer {
  let container: Promise<experimental_AstroContainer> | null = null;
  const containerOnce = () =>
    (container ??= (async () => {
      const [{ experimental_AstroContainer: Container }, mdx] = (await Promise.all([
        server.ssrLoadModule('astro/container'),
        server.ssrLoadModule('@astrojs/mdx/server.js'),
      ])) as [typeof import('astro/container'), { default: Parameters<experimental_AstroContainer['addServerRenderer']>[0]['renderer'] }];
      const created = await Container.create({
        // the resolved settings are the user settings with every default filled in
        astroConfig: { base: config.base, trailingSlash: config.trailingSlash, i18n: config.i18n, site: config.site } as AstroContainerUserConfig,
      });
      created.addServerRenderer({ name: 'astro:jsx', renderer: mdx.default });
      return created;
    })());
  let queue: Promise<unknown> = Promise.resolve();
  return (noteFile, module, page) => {
    const render = async (): Promise<string> => {
      const id = join(dirname(noteFile), BLOCK_MODULE);
      blockModules.set(id, module);
      const graph = server.environments.ssr.moduleGraph;
      const previous = graph.getModuleById(id);
      if (previous) graph.invalidateModule(previous);
      const [block, renderer] = await Promise.all([server.ssrLoadModule(id), containerOnce()]);
      return renderer.renderToString(block['default'] as Parameters<experimental_AstroContainer['renderToString']>[0], {
        request: new Request(page),
      });
    };
    const rendered = queue.then(render, render);
    queue = rendered.catch(() => undefined);
    return rendered;
  };
}
