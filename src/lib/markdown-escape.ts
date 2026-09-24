/**
 * Escaping for generated Markdown. Strings that come from outside the
 * author's hands — vault-derived titles and sources in the inbox importer,
 * the visible text of a wikilink a syndicated copy can no longer resolve —
 * are interpolated into prose, link labels and YAML frontmatter; each
 * context has its own rules, so a quote, a `]` or a `**` in such a string
 * stays display text instead of becoming syntax. Kept free of config and
 * server imports so the rules are unit-testable and usable from lib code.
 */
import { stringify } from 'yaml';

/**
 * Escape whatever would open a block at the start of a line of `text`
 * (after its indentation): a heading, a block quote, a bullet or ordered
 * list item, a thematic break or setext underline, a fence, a table row —
 * and, in MDX, an `import` / `export` statement, whose first letter
 * becomes a character reference. Only the constructions themselves are
 * touched (`**bold**` at a line start is emphasis, not a bullet), so
 * inline formatting survives. Inline, the escapes are invisible.
 */
export function escapeBlockStarts(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^([ \t]*)(#{1,6})(?=[ \t]|$)/, '$1\\$2')
        .replace(/^([ \t]*)(>)/, '$1\\$2')
        .replace(/^([ \t]*)([-+*])(?=[ \t])/, '$1\\$2')
        .replace(/^([ \t]*)([-*_])(?=(?:[ \t]*\2){2,}[ \t]*$)/, '$1\\$2')
        .replace(/^([ \t]*)(=)(?==*[ \t]*$)/, '$1\\$2')
        .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
        .replace(/^([ \t]*)([`~])(?=\2\2)/, '$1\\$2')
        .replace(/^([ \t]*)(\|)/, '$1\\$2')
        .replace(/^([ \t]*)import(?=\b)/, '$1&#105;mport')
        .replace(/^([ \t]*)export(?=\b)/, '$1&#101;xport'),
    )
    .join('\n');
}

/**
 * A visible text as inert inline Markdown or MDX: every character that
 * can start inline syntax — emphasis, code, links, autolinks and tags,
 * math, expressions, strikethrough, tables, character references — is
 * backslash-escaped, and a leading block opener as well
 * (escapeBlockStarts). `text` is the decoded visible text, so it is
 * escaped exactly once.
 */
export function escapeMarkdownInline(text: string): string {
  return escapeBlockStarts(text.replace(/[\\`*_[\]<>{}~$|&]/g, '\\$&'));
}

/**
 * A foreign string as inert prose or link-label text: whitespace runs
 * (newlines included — a newline would break out of the surrounding line)
 * collapse to single spaces, then escapeMarkdownInline.
 */
export function escapeMarkdownText(text: string): string {
  return escapeMarkdownInline(text.replace(/\s+/g, ' ').trim());
}

/**
 * A foreign URL safe inside a Markdown link destination `(…)`: the
 * characters that terminate or break the destination are percent-encoded,
 * everything else passes through unchanged (existing percent-escapes are
 * not double-encoded).
 */
export function escapeLinkUrl(url: string): string {
  return url.replace(/[()<>\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/**
 * A frontmatter block from string fields, serialized by the yaml package —
 * quoting, escaping and folding are its business, so any title round-trips
 * through the frontmatter parser byte-exactly. lineWidth 0 keeps each value
 * on its key's line.
 */
export function yamlFrontmatter(fields: Record<string, string>): string {
  return `---\n${stringify(fields, { lineWidth: 0 }).trimEnd()}\n---`;
}
