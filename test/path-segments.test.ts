/**
 * Path-segment predicates: whole-segment matching on both separators — the
 * inbox filters receive native win32 paths from the watcher while config
 * entries and state keys spell `/`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasPathSegment, pathSegments, toPosixPath } from '../src/lib/path-segments.ts';

test('segments split on either separator; empty segments are dropped', () => {
  assert.deepEqual(pathSegments('vault/_assets/img.png'), ['vault', '_assets', 'img.png']);
  assert.deepEqual(pathSegments('vault\\_assets\\img.png'), ['vault', '_assets', 'img.png']);
  assert.deepEqual(pathSegments('C:\\vault\\daily\\note.md'), ['C:', 'vault', 'daily', 'note.md']);
  assert.deepEqual(pathSegments('/posix//doubled/'), ['posix', 'doubled']);
  assert.deepEqual(pathSegments('mixed\\sep/path'), ['mixed', 'sep', 'path']);
});

test('hasPathSegment matches whole segments, never substrings', () => {
  assert.equal(hasPathSegment('/vault/_assets/note/img.png', '_assets'), true);
  assert.equal(hasPathSegment('C:\\vault\\_assets\\note\\img.png', '_assets'), true);
  assert.equal(hasPathSegment('C:\\vault\\_assets', '_assets'), true);
  assert.equal(hasPathSegment('/vault/_assets-backup/img.png', '_assets'), false);
  assert.equal(hasPathSegment('C:\\vault\\my_assets\\img.png', '_assets'), false);
  assert.equal(hasPathSegment('_assets.md', '_assets'), false);
});

test('toPosixPath respells relative paths with forward slashes', () => {
  assert.equal(toPosixPath('daily\\2026-08-22\\note.md'), 'daily/2026-08-22/note.md');
  assert.equal(toPosixPath('daily/2026-08-22/note.md'), 'daily/2026-08-22/note.md');
  assert.equal(toPosixPath('note.md'), 'note.md');
});
