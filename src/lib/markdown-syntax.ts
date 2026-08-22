/**
 * markdownSyntax — the Markdown dialect this CMS commits to (the parser-rule
 * layer), shared by its three consumers: the site's pages, the save-time
 * validation and the editor preview. One definition, so a block that
 * validates at save time parses the same way on the page.
 *
 * - GFM (tables, task lists, footnotes, autolinks, strikethrough), with a
 *   single `~` left literal: "~2 minutes" and "~15 items" are approximations,
 *   not a strikethrough span;
 * - CJK-friendly emphasis and strikethrough: markers hugging CJK punctuation
 *   (`**报文。**同时`) pair up.
 *
 * Parser extensions only, no transformers, so position in a plugin list is
 * irrelevant. The content guard (remarkContentGuard) is a transformer and is
 * mounted by the caller: page builds and save-time validation mount it, the
 * editor preview does not.
 */
import type { RemarkPlugin } from '@astrojs/markdown-remark';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkGfm from 'remark-gfm';

/** satisfies both unified's PluggableList and Astro's RemarkPlugins — feed it to either */
export type MarkdownSyntax = (RemarkPlugin | [RemarkPlugin, unknown])[];

const GFM = { singleTilde: false } as const;

export function markdownSyntax(): MarkdownSyntax {
  return [[remarkGfm, GFM], remarkCjkFriendly, [remarkCjkFriendlyGfmStrikethrough, GFM]];
}
