/**
 * Escaping for generated Markdown. The inbox importer interpolates
 * vault-derived strings (titles, authors, source names, URLs) into prose,
 * link labels and YAML frontmatter; each interpolation context has its own
 * rules, so a quote, a `]` or a `**` in a vault title stays display text
 * instead of becoming syntax. Kept free of config/server imports so the
 * rules are unit-testable.
 */
import { stringify } from 'yaml';

/**
 * A vault-derived string as inert prose or link-label text: whitespace runs
 * (newlines included — a newline would break out of the surrounding line)
 * collapse to single spaces, and every character that can open Markdown
 * syntax is backslash-escaped.
 */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>~$|]/g, '\\$&');
}

/**
 * A vault-derived URL safe inside a Markdown link destination `(…)`: the
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
