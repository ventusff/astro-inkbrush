/**
 * markdownSyntax — the Markdown dialect this CMS commits to (the
 * parser-rule layer), shared by all three consumers: the site's pages, the
 * block-save validation, and the editor preview.
 *
 * Why it is written down in exactly one place: a block that passes validation
 * at save time must render the same way on the page — and "the same way"
 * depends on which parser rules are on. Copy the plugin list into every
 * site's astro.config and sooner or later one site misses a rule. (The CJK
 * rules are the classic case: without them, `**` next to CJK punctuation
 * renders as bare asterisks.)
 *
 * - GFM (tables, task lists, footnotes, autolinks, strikethrough), but a
 *   single `~` is NOT strikethrough: technical prose is full of "~2 minutes" /
 *   "~15 items", and with single-tilde enabled everything between two such
 *   approximations gets struck through — in MDX it breaks parsing outright;
 * - CJK-friendly emphasis and strikethrough: markers hugging CJK punctuation
 *   (`**报文。**同时`) still pair up.
 *
 * Parser extensions only, no transformers — so position in a plugin list is
 * irrelevant. Guarding against leaked markers is a transformer
 * (remarkContentGuard) and mounting it is the caller's call: page builds
 * mount it, the editor preview doesn't (a half-typed asterisk is not an
 * incident).
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
