/**
 * The dev-server configuration the integration contributes: the CMS's own
 * state directory is unwatched, the dev toolbar is off, the client entry is
 * injected — and outside `astro dev` nothing happens at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { inkbrush } from '../src/wiki/integration.ts';

interface Captured {
  updates: Record<string, unknown>[];
  scripts: string[];
  warnings: string[];
}

async function setup(command: 'dev' | 'build'): Promise<Captured> {
  const captured: Captured = { updates: [], scripts: [], warnings: [] };
  const hook = inkbrush().hooks['astro:config:setup'];
  assert.ok(hook);
  await hook({
    command,
    config: { root: pathToFileURL(`${process.cwd()}/`) },
    injectScript: (_stage: string, content: string) => {
      captured.scripts.push(content);
    },
    logger: {
      warn: (m: string) => {
        captured.warnings.push(m);
      },
      info: () => undefined,
      error: () => undefined,
    },
    updateConfig: (update: Record<string, unknown>) => {
      captured.updates.push(update);
      return update;
    },
  } as never);
  return captured;
}

test('under astro dev: .wiki/ is unwatched, the toolbar off, the client injected', async () => {
  const { updates, scripts, warnings } = await setup('dev');
  assert.equal(updates.length, 1);
  const update = updates[0]!;
  const vite = update['vite'] as { server: { watch: { ignored: string[] } } };
  assert.ok(vite.server.watch.ignored.includes('**/.wiki/**'));
  assert.deepEqual(update['devToolbar'], { enabled: false });
  assert.equal(scripts.length, 1);
  assert.match(scripts[0]!, /client\/index\.ts/);
  assert.deepEqual(warnings, []);
});

test('outside astro dev the integration changes nothing', async () => {
  const { updates, scripts, warnings } = await setup('build');
  assert.deepEqual(updates, []);
  assert.deepEqual(scripts, []);
  assert.equal(warnings.length, 1);
});
