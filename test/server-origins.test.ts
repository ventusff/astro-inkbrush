/** originTrusted: exact entries, scheme://*.suffix wildcards; scheme and
 *  port exact, hostname must gain at least one label, apex never matches. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { originTrusted } from '../src/wiki/server/origins.ts';

test('exact entries match themselves only', () => {
  assert.equal(originTrusted('https://plan.example.com', ['https://plan.example.com']), true);
  assert.equal(originTrusted('https://plan.example.com:8443', ['https://plan.example.com']), false);
});

test('wildcards: subdomains yes, apex no, scheme and port exact', () => {
  const t = ['https://*.hub.example.com'];
  assert.equal(originTrusted('https://x.hub.example.com', t), true);
  assert.equal(originTrusted('https://x.y.hub.example.com', t), true);
  assert.equal(originTrusted('https://hub.example.com', t), false);
  assert.equal(originTrusted('http://x.hub.example.com', t), false);
  assert.equal(originTrusted('https://x.hub.example.com:8443', t), false);
  assert.equal(originTrusted('https://xhub.example.com', t), false);
});

test('wildcard with port matches that port only', () => {
  const t = ['http://*.local:4321'];
  assert.equal(originTrusted('http://a.local:4321', t), true);
  assert.equal(originTrusted('http://a.local', t), false);
});

test('garbage origins never match', () => {
  assert.equal(originTrusted('not-a-url', ['https://*.hub.example.com']), false);
});
