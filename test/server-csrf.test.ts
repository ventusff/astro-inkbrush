import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crossSiteBlocked } from '../src/wiki/server/csrf.ts';

const base = {
  method: 'POST',
  path: '/comments/a',
  ownOrigins: ['https://wiki.example.com'],
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

test('every own origin counts — a pinned identity base URL does not displace the served host', () => {
  // an editing machine that borrows another host's SAML SP identity still
  // serves its own pages on its own subdomain
  const both = { ...base, ownOrigins: ['https://labs.example.com', 'https://hub.example.com'] };
  assert.equal(crossSiteBlocked({ ...both, origin: 'https://labs.example.com' }), false);
  assert.equal(crossSiteBlocked({ ...both, origin: 'https://hub.example.com' }), false);
  assert.equal(crossSiteBlocked({ ...both, origin: 'https://evil.example' }), true);
});

test('a wildcard trusted origin admits any one-or-more-label subdomain, never the apex', () => {
  const opts = { ...base, trustedOrigins: ['https://*.hub.example.com'] };
  assert.equal(crossSiteBlocked({ ...opts, origin: 'https://aws-wiki-edit.hub.example.com' }), false);
  assert.equal(crossSiteBlocked({ ...opts, origin: 'https://a.b.hub.example.com' }), false);
  assert.equal(crossSiteBlocked({ ...opts, origin: 'https://hub.example.com' }), true);
  assert.equal(crossSiteBlocked({ ...opts, origin: 'http://aws.hub.example.com' }), true);
  assert.equal(crossSiteBlocked({ ...opts, origin: 'https://evilhub.example.com' }), true);
});
