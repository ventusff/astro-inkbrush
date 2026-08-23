/**
 * Note identity primitives: the id grammar and frontmatter field access.
 * Kept free of config/server imports so both are unit-testable.
 */
import { splitFrontmatter } from '../../lib/frontmatter.ts';

/**
 * A note id: slash-separated segments of Unicode letters, numbers, `_`,
 * `.` and `-`; a segment never starts with `.` or `-` (no hidden files, no
 * option-looking names) and never is empty. Matches what the content
 * scanner discovers, so every scanned note is also addressable.
 */
export const NOTE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(\/[\p{L}\p{N}_][\p{L}\p{N}_.-]*)*$/u;

/**
 * A scalar frontmatter field of `source`, read through the shared splitter
 * (lib/frontmatter.ts — one acceptance rule for every consumer). Returns
 * the field's string value (numbers/booleans stringified); null when the
 * file has no frontmatter, the YAML does not parse as a mapping, or the
 * field is absent or not scalar.
 */
export function frontmatterField(source: string, field: string): string | null {
  const { data, error } = splitFrontmatter(source);
  if (error) return null;
  const value = data[field];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
