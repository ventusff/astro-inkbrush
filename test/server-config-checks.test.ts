import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkAutopush,
  checkContentDir,
  checkCookieDomain,
  checkCookieName,
  checkHttpUrl,
  checkTrustedOrigins,
} from '../src/wiki/server/config-checks.ts';

test('cookie names must be RFC 6265 tokens', () => {
  for (const ok of ['wiki_session', 'team-session', 'S1', '__Host-wiki']) {
    assert.doesNotThrow(() => checkCookieName(ok), ok);
  }
  for (const bad of ['', 'has space', 'semi;colon', 'wiki=1', 'wiki\n', '名字']) {
    assert.throws(() => checkCookieName(bad), /cookieName/, `'${bad}' should be refused`);
  }
});

test('cookie domains must look like domains', () => {
  assert.doesNotThrow(() => checkCookieDomain(null));
  for (const ok of ['.example.com', 'example.com', 'wiki.internal', 'localhost']) {
    assert.doesNotThrow(() => checkCookieDomain(ok), ok);
  }
  for (const bad of ['', 'http://example.com', 'exa mple.com', '.example.com/path', '-bad.com']) {
    assert.throws(() => checkCookieDomain(bad), /cookieDomain/, `'${bad}' should be refused`);
  }
});

test('trusted origins must be bare http(s) origins', () => {
  assert.doesNotThrow(() => checkTrustedOrigins([]));
  assert.doesNotThrow(() => checkTrustedOrigins(['https://app.example.com', 'http://localhost:4321']));
  for (const bad of ['not a url', 'ftp://x', 'https://x/path', 'https://x?q=1', 'example.com']) {
    assert.throws(() => checkTrustedOrigins([bad]), /trustedOrigins/, `'${bad}' should be refused`);
  }
});

test('base/gateway URLs must parse as http(s); empty means unconfigured and passes', () => {
  assert.doesNotThrow(() => checkHttpUrl('share.gatewayUrl', null));
  assert.doesNotThrow(() => checkHttpUrl('share.gatewayUrl', ''));
  assert.doesNotThrow(() => checkHttpUrl('share.gatewayUrl', 'http://gateway.internal:8787'));
  assert.throws(() => checkHttpUrl('share.gatewayUrl', 'gateway.internal'), /share\.gatewayUrl/);
  assert.throws(() => checkHttpUrl('auth.google.baseUrl', 'file:///etc'), /auth\.google\.baseUrl/);
});

test('content.dir must be a relative path inside the site', () => {
  assert.doesNotThrow(() => checkContentDir('src/content/notes'));
  assert.throws(() => checkContentDir('/abs/notes'), /absolute/);
  assert.throws(() => checkContentDir('../outside'), /'\.\.'/);
  assert.throws(() => checkContentDir('  '), /empty/);
});

test('autopush without autocommit is a config error', () => {
  assert.doesNotThrow(() => checkAutopush(true, true));
  assert.doesNotThrow(() => checkAutopush(false, false));
  assert.doesNotThrow(() => checkAutopush(true, false));
  assert.throws(() => checkAutopush(false, true), /autopush requires autocommit/);
});
