import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossSiteBlocked } from '../src/wiki/server/csrf.ts';

const base = {
  method: 'POST',
  path: '/comments/a',
  ownOrigin: 'https://wiki.example.com',
  trustedOrigins: [] as string[],
};

test('safe methods and originless requests pass', () => {
  assert.equal(crossSiteBlocked({ ...base, method: 'GET', origin: 'https://evil.example' }), false);
  assert.equal(crossSiteBlocked({ ...base, method: 'HEAD', origin: 'https://evil.example' }), false);
  assert.equal(crossSiteBlocked({ ...base, method: 'OPTIONS', origin: 'https://evil.example' }), false);
  assert.equal(crossSiteBlocked({ ...base, origin: null }), false);
});

test('a mutating request from another origin is blocked unless trusted', () => {
  assert.equal(crossSiteBlocked({ ...base, origin: 'https://wiki.example.com' }), false);
  assert.equal(crossSiteBlocked({ ...base, origin: 'https://evil.example' }), true);
  assert.equal(
    crossSiteBlocked({ ...base, origin: 'https://app.example.com', trustedOrigins: ['https://app.example.com'] }),
    false,
  );
});

test('the SAML ACS route is exempt — the IdP posts it cross-origin by design', () => {
  assert.equal(
    crossSiteBlocked({ ...base, path: '/auth/saml/callback', origin: 'https://accounts.google.com' }),
    false,
  );
  // only that exact route is exempt
  assert.equal(
    crossSiteBlocked({ ...base, path: '/auth/saml/callback/extra', origin: 'https://accounts.google.com' }),
    true,
  );
});
