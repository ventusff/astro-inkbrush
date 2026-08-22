/**
 * astro-inkbrush — a minimal CMS component (wiki-style in-place editing /
 * comments / AI ask·rewrite·translate / inbox import / revision history with
 * rollback). Formatting, CSS, layout, components, the rendering pipeline and
 * routing all belong to the site — this package touches none of them.
 *
 * Site integration (three things):
 *   1. astro.config: `...(WIKI_MODE ? [inkbrush()] : [])`, and add
 *      `rehypeWikiBlocks` to the site's own markdown pipeline (WIKI mode only);
 *   2. the note page's head emits `<meta name="inkbrush-note" content={noteId}>`
 *      (optionally `<meta name="inkbrush-note-url" content="/{id}/">` to
 *      customize the jump-URL template);
 *   3. an `inkbrush.config.ts` at the site root (template:
 *      inkbrush.config.example.ts).
 */
export { defineInkbrushConfig } from './wiki/config';
export type { GoogleAuthConfig, InkbrushConfig, InkbrushConfigInput } from './wiki/config';
export { inkbrush } from './wiki/integration';
export { rehypeWikiBlocks } from './lib/rehype-wiki-blocks';
