/**
 * What the consuming site tells the CMS about its own Markdown pipeline, so
 * that the editor's preview, the save-time validation and the AI gate render
 * and check a note with the same plugins the page is built with.
 *
 * The integration receives these from `inkbrush({ markdown })` in the site's
 * astro.config and hands them to the server module on every request and at
 * init; nothing here is read from disk.
 */
import type { Options as RemarkRehypeOptions } from 'remark-rehype';
import type { PluggableList } from 'unified';

import type { ContentGuardOptions } from '../../lib/content-guard.ts';
import type { FrontmatterSchema } from '../../lib/frontmatter-schema.ts';
import type { SitePluginSet } from '../../lib/render-pipeline.ts';

export interface SiteMarkdownHooks {
  /** the site's remark plugins, mounted after the dialect (as in its pipeline) */
  remarkPlugins?: PluggableList | undefined;
  /** the site's rehype plugins, mounted before sanitising/stringifying */
  rehypePlugins?: PluggableList | undefined;
  /** the site's full page pipeline, when `remarkPlugins` / `rehypePlugins`
   *  leave out plugins that only hold for a whole note (heading numbering
   *  and its cross-references, reading time): the editor preview renders a
   *  fragment and keeps the lists above, every whole-note gate — manual
   *  save, AI job, inbox import — compiles with these instead, so it
   *  refuses what the page build refuses. Omitted = the lists above. */
  page?: SitePluginSet | undefined;
  /** the site's content-guard options (the `guard` it passes to
   *  markdownProcessor), so the save gate refuses exactly what the build
   *  refuses; omitted = the guard's defaults */
  guard?: ContentGuardOptions | undefined;
  /** the site's remark-rehype bridge options (markdownProcessor's
   *  `remarkRehype`), applied by the preview and the save-time validation
   *  of .md notes */
  remarkRehype?: RemarkRehypeOptions | undefined;
  /** the site's frontmatter schema — its content-collection schema (an
   *  `astro/zod` schema as it is, or any Standard Schema), so the save gate
   *  refuses the frontmatter the build refuses; omitted = YAML must parse,
   *  nothing more */
  frontmatter?: FrontmatterSchema | undefined;
  /** note id → the URL the site routes it to (default `/${id}/`) */
  urlFor?: ((id: string) => string) | undefined;
}

let hooks: SiteMarkdownHooks = {};

export function setSiteHooks(next: SiteMarkdownHooks | undefined): void {
  hooks = next ?? {};
}

export function siteHooks(): SiteMarkdownHooks {
  return hooks;
}

export function noteUrl(id: string): string {
  return hooks.urlFor ? hooks.urlFor(id) : `/${id}/`;
}
