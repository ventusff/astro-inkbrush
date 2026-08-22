/**
 * Note identity primitives: the id grammar and frontmatter field access.
 * Kept free of config/server imports so both are unit-testable.
 */
import { parseDocument } from 'yaml';

/**
 * A note id: slash-separated segments of Unicode letters, numbers, `_`,
 * `.` and `-`; a segment never starts with `.` or `-` (no hidden files, no
 * option-looking names) and never is empty. Matches what the content
 * scanner discovers, so every scanned note is also addressable.
 */
export const NOTE_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*(\/[\p{L}\p{N}_][\p{L}\p{N}_.-]*)*$/u;

/**
 * A scalar frontmatter field of `source`, parsed as YAML. Returns the
 * field's string value (numbers/booleans stringified); null when the file
 * has no frontmatter, the YAML does not parse, or the field is absent or
 * not scalar.
 */
export function frontmatterField(source: string, field: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!fm) return null;
  try {
    const doc = parseDocument(fm[1]!);
    if (doc.errors.length > 0) return null;
    const data: unknown = doc.toJS();
    if (typeof data !== 'object' || data === null) return null;
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  } catch {
    return null;
  }
}
