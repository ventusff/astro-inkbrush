// @ts-check
import { defineConfig } from 'astro/config';
import { markdownProcessor } from 'astro-inkbrush/markdown';
import { buildWikilinkResolver, cachedScan, remarkWikilinks } from 'astro-inkbrush/wikilinks';

// WIKI=1 astro dev → editing mode: the inkbrush integration mounts the CMS
// (client UI + /api/wiki middleware) and rehypeWikiBlocks stamps each block
// with its source line range. A plain `astro build` takes neither import —
// the published site is byte-identical to one that never installed the CMS.
const WIKI_MODE = Boolean(process.env.WIKI);
const engine = WIKI_MODE ? await import('astro-inkbrush') : null;

// Deploy target comes from the environment: GitHub Pages project sites live
// under a sub-path (DEMO_BASE=/astro-inkbrush/), local dev at the root.
const SITE = process.env.DEMO_SITE || 'https://example.com';
const BASE = (process.env.DEMO_BASE || '/').replace(/\/+$/, '') || '';

// [[wikilinks]] — the engine ships the one implementation shared by page
// rendering, editor preview and the inbox importer; the site supplies the
// resolution domain (which notes exist) and the routing (where a note lives).
// remarkWikilinks is a unified plugin: mount it as a [plugin, options] pair.
const CONTENT_DIR = new URL('./src/content/notes', import.meta.url).pathname;
const wikilinkOptions = {
  resolve: buildWikilinkResolver({
    notes: cachedScan(CONTENT_DIR),
    urlFor: (id) => `${BASE}/notes/${id}/`,
    locales: [
      { code: 'en', prefix: '' },
      { code: 'zh', prefix: 'zh/' },
    ],
  }),
  noteIdOf: (path) => {
    if (!path) return undefined;
    const m = path.replace(/\\/g, '/').match(/src\/content\/notes\/(.+)\/index\.mdx?$/);
    return m?.[1];
  },
  onBroken: ({ file, target, kind }) =>
    console.warn(`[wikilinks] ${kind}: [[${target}]] ← ${file ?? '(unknown)'}`),
};

export default defineConfig({
  site: SITE,
  base: BASE || '/',
  trailingSlash: 'ignore',
  integrations: [...(engine ? [engine.inkbrush()] : [])],
  markdown: {
    // The engine's Markdown dialect (GFM with single-tilde off, CJK-friendly
    // emphasis) plus the content guard, then the site's own plugins. What the
    // editor accepts and what the page renders are one grammar by construction.
    processor: markdownProcessor({
      remarkPlugins: [[remarkWikilinks, wikilinkOptions]],
      rehypePlugins: [...(engine ? [engine.rehypeWikiBlocks] : [])],
    }),
  },
});
