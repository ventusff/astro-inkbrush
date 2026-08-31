/**
 * The snapshot build's environment: allowlisted like every child the CMS
 * spawns, and always a production build — the dev server's own
 * NODE_ENV=development must not leak into it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { snapshotEnv } from '../src/wiki/server/snapshot.ts';

const SERVER_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  NODE_ENV: 'development',
  NODE_OPTIONS: '--dns-result-order=ipv4first',
  ASTRO_TELEMETRY_DISABLED: '1',
  PUBLIC_SITE_NAME: 'garden',
  WIKI: '1',
  WIKI_DEV_LOGIN: '1',
  SHARE_GATEWAY_TOKEN: 'nope',
  AUTH_SECRET: 'nope',
  GOOGLE_CLIENT_SECRET: 'nope',
};

test('the build runs in production mode whatever the server process says', () => {
  const env = snapshotEnv(SERVER_ENV);
  assert.equal(env['NODE_ENV'], 'production');
  // the rest of the allowlist still passes
  assert.equal(env['NODE_OPTIONS'], '--dns-result-order=ipv4first');
  assert.equal(env['ASTRO_TELEMETRY_DISABLED'], '1');
  assert.equal(env['PUBLIC_SITE_NAME'], 'garden');
  assert.equal(env['PATH'], '/usr/bin');
});

test('WIKI, WIKI_* and server secrets never reach the build', () => {
  const env = snapshotEnv(SERVER_ENV);
  for (const key of ['WIKI', 'WIKI_DEV_LOGIN', 'SHARE_GATEWAY_TOKEN', 'AUTH_SECRET', 'GOOGLE_CLIENT_SECRET']) {
    assert.equal(env[key], undefined, key);
  }
});

test('an unset NODE_ENV is pinned to production as well', () => {
  const { NODE_ENV: _dev, ...withoutNodeEnv } = SERVER_ENV;
  assert.equal(snapshotEnv(withoutNodeEnv)['NODE_ENV'], 'production');
});
