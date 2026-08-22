/**
 * Comments: append-only NDJSON per note (.wiki/data/comments/<id>.ndjson,
 * deletions are tombstone records). Markdown is rendered server-side through
 * the sanitizing unified pipeline (GFM + KaTeX math), so stored html is safe
 * to inject verbatim.
 *
 * The stored record keeps the author's email — it is the ownership key for
 * deletion. API responses never carry it: the client receives
 * `{ id, author: { name, provider }, canDelete, markdown, html, ts }`, where
 * `canDelete` says the requesting user authored the comment.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { commentView, type StoredComment } from './comment-view.ts';
import type { RouteRegistrar } from './index.ts';
import { fail, json, readBody } from './index.ts';
import { renderMarkdown } from './markdown.ts';
import { noteFile } from './source.ts';
import { appendNdjson, noteKey, readNdjson, wikiDataDir } from './store.ts';

function commentsFile(noteId: string): string {
  return join(wikiDataDir('comments'), `${noteKey(noteId)}.ndjson`);
}

type CommentRecord = StoredComment | { id: string; deleted: true; by: string; ts: number };

function loadComments(noteId: string): StoredComment[] {
  const records = readNdjson<CommentRecord>(commentsFile(noteId));
  const alive = new Map<string, StoredComment>();
  for (const record of records) {
    if ('deleted' in record && record.deleted) alive.delete(record.id);
    else alive.set(record.id, record as StoredComment);
  }
  return [...alive.values()].sort((a, b) => a.ts - b.ts);
}

export function registerCommentRoutes(on: RouteRegistrar): void {
  on('GET', '/comments/*id', ({ res, params, user }) => {
    const id = params['id']!;
    if (!noteFile(id)) return fail(res, 404, 'Note not found');
    json(res, 200, { comments: loadComments(id).map((c) => commentView(c, user?.email ?? null)) });
  });

  on(
    'POST',
    '/comments/*id',
    async ({ req, res, params, user }) => {
      const id = params['id']!;
      if (!noteFile(id)) return fail(res, 404, 'Note not found');
      const { markdown } = await readBody<{ markdown?: string }>(req);
      const text = markdown?.trim();
      if (!text) return fail(res, 400, 'Comment cannot be empty');
      if (text.length > 10_000) return fail(res, 413, 'Comment too long (>10000 characters)');
      const comment: StoredComment = {
        id: randomUUID(),
        author: {
          name: user!.name,
          email: user!.email,
          ...(user!.picture ? { picture: user!.picture } : {}),
          provider: user!.provider,
        },
        markdown: text,
        html: await renderMarkdown(text, { sanitize: true }),
        ts: Date.now(),
      };
      appendNdjson(commentsFile(id), comment);
      json(res, 200, { comment: commentView(comment, user!.email) });
    },
    { auth: true },
  );

  on(
    'DELETE',
    '/comments/*id',
    ({ res, params, query, user }) => {
      const id = params['id']!;
      const cid = query.get('cid');
      if (!cid) return fail(res, 400, 'missing cid');
      const target = loadComments(id).find((c) => c.id === cid);
      if (!target) return fail(res, 404, 'Comment not found');
      if (target.author.email !== user!.email) return fail(res, 403, 'You can only delete your own comments');
      appendNdjson(commentsFile(id), { id: cid, deleted: true, by: user!.email, ts: Date.now() });
      json(res, 200, { ok: true });
    },
    { auth: true },
  );
}
