/**
 * What the consuming site tells the CMS about its own Markdown pipeline, so
 * that the editor's preview, the save-time validation and the AI gate render
 * and check a note with the same plugins the page is built with.
 *
 * The integration receives these from `inkbrush({ markdown })` in the site's
 * astro.config and hands them to the server module on every request and at
 * init; nothing here is read from disk.
 */
import type { PluggableList } from 'unified';

export interface SiteMarkdownHooks {
  /** the site's remark plugins, mounted after the dialect (as in its pipeline) */
  remarkPlugins?: PluggableList | undefined;
  /** the site's rehype plugins, mounted before sanitising/stringifying */
  rehypePlugins?: PluggableList | undefined;
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
