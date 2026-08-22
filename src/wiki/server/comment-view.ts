/**
 * Comment record ↔ API view. The NDJSON on disk keeps the author's email
 * (ownership) and picture; the API response never carries the email — the
 * client gets a `canDelete` verdict instead. Kept free of config/server
 * imports so the mapping is unit-testable.
 */
import type { WikiComment, WikiUser } from '../shared/types.ts';

/** a comment as stored in .wiki/data/comments/<key>.ndjson */
export interface StoredComment {
  id: string;
  author: Pick<WikiUser, 'name' | 'email' | 'picture' | 'provider'>;
  /** raw markdown as submitted */
  markdown: string;
  /** sanitized rendered HTML */
  html: string;
  ts: number;
}

/** the API response shape: no email, `canDelete` = the requester authored it */
export function commentView(record: StoredComment, requesterEmail: string | null): WikiComment {
  return {
    id: record.id,
    author: { name: record.author.name, provider: record.author.provider },
    canDelete: requesterEmail !== null && record.author.email === requesterEmail,
    markdown: record.markdown,
    html: record.html,
    ts: record.ts,
  };
}
