import assert from 'node:assert/strict';
import { test } from 'node:test';

import { childEnv } from '../src/wiki/server/child-env.ts';

test('only the base set plus requested names/prefixes pass; drop wins', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LC_ALL: 'C.UTF-8',
    https_proxy: 'http://proxy:3128',
    AUTH_SECRET: 'nope',
    SHARE_GATEWAY_TOKEN: 'nope',
    WIKI_DEV_LOGIN: '1',
    GOOGLE_CLIENT_SECRET: 'nope',
    ANTHROPIC_API_KEY: 'key',
    CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  const env = childEnv({ prefixes: ['ANTHROPIC_', 'CLAUDE_'], drop: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] }, source);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LC_ALL: 'C.UTF-8',
    https_proxy: 'http://proxy:3128',
    ANTHROPIC_API_KEY: 'key',
    CLAUDE_CONFIG_DIR: '/cfg',
  });
  const buildEnv = childEnv({ prefixes: ['NODE_', 'ASTRO_', 'PUBLIC_'] }, source);
  assert.equal(buildEnv['NODE_OPTIONS'], '--max-old-space-size=4096');
  assert.equal(buildEnv['WIKI_DEV_LOGIN'], undefined);
  assert.equal(buildEnv['AUTH_SECRET'], undefined);
});
