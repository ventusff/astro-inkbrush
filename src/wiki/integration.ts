/**
 * Wiki mode — an OPTIONAL Astro integration, active only when the dev server
 * is started with WIKI=1 (`npm run wiki`). The static build (`npm run build`)
 * never sees any of this: astro.config.ts adds the integration and the
 * rehype-wiki-blocks plugin conditionally, so the published site stays
 * byte-identical to the pure-static baseline.
 *
 *  - injects the client UI bundle into every page (Vite-bundled TS)
 *  - mounts the /api/wiki middleware on the dev server (via ssrLoadModule,
 *    so server code hot-reloads too)
 *  - calls the server-side init (project root + whatever the deployment's
 *    inkbrush.config.ts enables, e.g. the optional Obsidian inbox watcher)
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

/**
 * Locate this package's src/wiki directory. The integration injects its own
 * client entry and ssr-loads its own server entry, so it must know where its
 * source lives — and that differs by consumption mode:
 *  1. consumed as a package whose module survived config bundling intact →
 *     import.meta.url points at the real file;
 *  2. bundled INTO the astro.config bundle (in-repo / inlined consumption) →
 *     import.meta.url points at the temp bundle, fall back to <root>/src/wiki;
 *  3. otherwise resolve the 'astro-inkbrush' package from the app root.
 */
function wikiSrcDir(root: string): string {
  const fromMeta = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(fromMeta, 'client/index.ts'))) return fromMeta;
  const inRepo = join(root, 'src/wiki');
  if (existsSync(join(inRepo, 'client/index.ts'))) return inRepo;
  const require = createRequire(join(root, 'package.json'));
  return join(dirname(require.resolve('astro-inkbrush/package.json')), 'src/wiki');
}

/** absolute fs path → Vite-importable id (the dev server's /@fs form) */
function viteId(abs: string): string {
  return `/@fs${abs}`;
}

export function inkbrush(): AstroIntegration {
  let root = process.cwd();
  let srcDir = '';
  return {
    name: 'inkbrush',
    hooks: {
      'astro:config:setup': ({ command, config, injectScript, logger, updateConfig }) => {
        if (command !== 'dev') {
          logger.warn('wiki mode only runs under astro dev (WIKI=1 astro dev)');
          return;
        }
        root = fileURLToPath(config.root);
        srcDir = wikiSrcDir(root);
        injectScript('page', `import '${viteId(join(srcDir, 'client/index.ts'))}';`);
        // allowing the deployment's Host header (vite allowedHosts) is a
        // site-level concern — the site's own astro.config sets it; the CMS
        // component stays out of it.
        updateConfig({
          // wiki mode is for editors, not site developers: Astro's dev
          // toolbar (island audit and other dev instrumentation) is noise in
          // an editing surface, so it's disabled. A plain `astro dev` without
          // WIKI never loads this integration and keeps the toolbar.
          devToolbar: { enabled: false },
          vite: {
            // CodeMirror is only reached via a lazy import (editor.ts), so
            // Vite's startup dep-scan misses it; without this, the first
            // click on ✎ hits a 504 "outdated optimize dep" and the editor
            // never opens. The right include spelling depends on the
            // consumption layout: when the site root can resolve the bare
            // name (npm file:/in-repo layouts) use it directly; under pnpm's
            // strict layout CodeMirror exists only in this package's own
            // node_modules, so the entry is addressed through the package
            // that depends on it (`pkg > dep`). Vite silently drops include
            // entries it cannot resolve, so picking the wrong form loses the
            // pre-bundle without any error — hence the probe.
            optimizeDeps: {
              include: [
                '@codemirror/autocomplete',
                '@codemirror/commands',
                '@codemirror/lang-markdown',
                '@codemirror/language',
                '@codemirror/state',
                '@codemirror/view',
              ].map((dep) => {
                try {
                  createRequire(join(root, 'package.json')).resolve(dep);
                  return dep;
                } catch {
                  return `astro-inkbrush > ${dep}`;
                }
              }),
            },
          },
        });
      },
      'astro:server:setup': ({ server, logger }) => {
        const serverEntry = viteId(join(srcDir || join(root, 'src/wiki'), 'server/index.ts'));
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/api/wiki/')) return next();
          server
            .ssrLoadModule(serverEntry)
            .then((mod) =>
              (mod as { handleApi: (rq: typeof req, rs: typeof res, o: { root: string }) => Promise<void> })
                .handleApi(req, res, { root }),
            )
            .catch((err: unknown) => {
              logger.error(`api error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ error: 'wiki server module failed to load' }));
              } else {
                res.end();
              }
            });
        });
        // server-side init (fire-and-forget; watcher module guards against
        // double-start across HMR reloads)
        server
          .ssrLoadModule(serverEntry)
          .then((mod) => (mod as { initWiki: (root: string) => void }).initWiki(root))
          .catch((err: unknown) => logger.error(`wiki init failed: ${String(err)}`));
      },
    },
  };
}
