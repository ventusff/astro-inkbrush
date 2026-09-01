/**
 * astro-inkbrush — a minimal CMS component (wiki-style in-place editing /
 * comments / AI ask·rewrite·translate / inbox import / revision history with
 * rollback). Page formatting, layout, components, the rendering pipeline and
 * routing belong to the site; Inkbrush styles only its own chrome (the
 * editor UI and wiki.css travel with the client, injected in WIKI mode and
 * absent from static builds — check-dist holds the zero-injection line).
 *
 * Site integration:
 *   1. astro.config: `...(WIKI_MODE ? [inkbrush()] : [])`, and add
 *      `rehypeWikiBlocks` to the site's own markdown pipeline (WIKI mode only);
 *   2. the note page's head emits `<meta name="inkbrush-note" content={noteId}>`
 *      (optionally `<meta name="inkbrush-note-url" content="/{id}/">` to
 *      customize the jump-URL template);
 *   3. optionally an `inkbrush.config.ts` at the site root — absent, the
 *      defaults apply (template: inkbrush.config.example.ts), authored
 *      against `astro-inkbrush/config` — defineInkbrushConfig and the whole
 *      config-type family live on that subpath, which a config file can
 *      import without pulling server code.
 *
 * The root surface is deliberately the integration contract and nothing
 * else; config authoring belongs to `astro-inkbrush/config`.
 */
export { inkbrush, type InkbrushOptions } from './wiki/integration.ts';
export type { SiteMarkdownHooks } from './wiki/server/site.ts';
export type { FrontmatterSchema } from './lib/frontmatter-schema.ts';
export { rehypeWikiBlocks } from './lib/rehype-wiki-blocks.ts';
