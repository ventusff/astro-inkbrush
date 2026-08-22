import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commentView, type StoredComment } from '../src/wiki/server/comment-view.ts';

const stored: StoredComment = {
  id: 'c1',
  author: {
    name: 'Ada',
    email: 'ada@example.com',
    picture: 'https://example.com/a.png',
    provider: 'google',
  },
  markdown: 'hi',
  html: '<p>hi</p>',
  ts: 1700000000000,
};

test('the API view carries exactly the contract fields and never the email', () => {
  const view = commentView(stored, null);
  assert.deepEqual(Object.keys(view).sort(), ['author', 'canDelete', 'html', 'id', 'markdown', 'ts']);
  assert.deepEqual(view.author, { name: 'Ada', provider: 'google' });
  assert.ok(!('email' in view.author));
  assert.ok(!('picture' in view.author));
  assert.ok(!JSON.stringify(view).includes('ada@example.com'));
});

test('canDelete is true exactly for the stored author', () => {
  assert.equal(commentView(stored, 'ada@example.com').canDelete, true);
  assert.equal(commentView(stored, 'someone@else.com').canDelete, false);
  assert.equal(commentView(stored, null).canDelete, false);
});
