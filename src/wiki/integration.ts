/**
 * Wiki mode — an optional Astro integration for the dev server. The static
 * build never sees any of it: the site adds the integration and the
 * rehype-wiki-blocks plugin only when it runs as an editing host (WIKI=1),
 * and the integration itself does nothing outside `astro dev`, so the
 * published site is byte-identical to one that never installed it.
 *
 *  - injects the client UI bundle into every page (Vite-bundled TS)
 *  - mounts the /api/wiki middleware on the dev server (via ssrLoadModule,
 *    so server code hot-reloads too)
 *  - hands the site's Markdown pipeline (`markdown` option) to the server,
 *    so preview and save-time validation use the page's own plugins
 *  - calls the server-side init (project root + whatever the deployment's
 *    inkbrush.config.ts enables, e.g. the optional Obsidian inbox watcher)
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroIntegration } from 'astro';

import type { SiteMarkdownHooks } from './server/site.ts';

export interface InkbrushOptions {
  /** the site's Markdown pipeline beyond the dialect: the remark/rehype
   *  plugins its pages use and its note-id → URL rule. The editor preview,
   *  the save-time validation and the AI gate run them too. */
  markdown?: SiteMarkdownHooks;
}

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

export function inkbrush(options: InkbrushOptions = {}): AstroIntegration {
  let root = process.cwd();
  let srcDir = '';
  const serverOptions = { markdown: options.markdown };
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
        // the deployment's Host header (vite allowedHosts) is the site's own
        // astro.config setting
        updateConfig({
          // an editing surface: Astro's dev toolbar is off (a plain `astro
          // dev` without WIKI never loads this integration and keeps it)
          devToolbar: { enabled: false },
          vite: {
            // CodeMirror is reached through a lazy import (editor.ts), which
            // Vite's startup dependency scan does not see, so it is
            // pre-bundled explicitly. The entry is the bare name when the site
            // root resolves it (npm file: / in-repo layouts) and the
            // `astro-inkbrush > dep` form under pnpm's strict layout, where
            // the dependency exists only in this package's node_modules.
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
      'astro:server:setup': async ({ server, logger }) => {
        const serverEntry = viteId(join(srcDir || join(root, 'src/wiki'), 'server/index.ts'));
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/api/wiki/')) return next();
          server
            .ssrLoadModule(serverEntry)
            .then((mod) =>
              (mod as { handleApi: (rq: typeof req, rs: typeof res, o: { root: string; markdown?: SiteMarkdownHooks | undefined }) => Promise<void> })
                .handleApi(req, res, { root, ...serverOptions }),
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
        // server-side init, awaited: a configuration error (bad config
        // values, unusable identity registry) rethrows and fails `astro dev`
        // loudly — the server must not keep serving with broken auth.
        // Optional pieces (the inbox watcher) are non-fatal inside initWiki
        // and log their own failure; the watcher module guards against
        // double-start across HMR reloads.
        try {
          const mod = (await server.ssrLoadModule(serverEntry)) as {
            initWiki: (root: string, o: { markdown?: SiteMarkdownHooks | undefined }) => void;
          };
          mod.initWiki(root, serverOptions);
        } catch (err) {
          logger.error(`wiki init failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          throw err;
        }
      },
    },
  };
}
