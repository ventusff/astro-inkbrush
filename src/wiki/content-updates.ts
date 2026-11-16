/**
 * How the dev server tells the open pages about a note the CMS just wrote.
 *
 * Left to itself, a note's file changing reloads every open page twice over:
 * Astro's HMR treats the note's module (an MDX note is a server-only module)
 * as a reason for a full reload, and its content layer, once the changed
 * entry is written to its store, sends a full reload of its own. The content
 * layer has no hook for that second one: it sends it straight to the
 * browser's channel whenever its store file changes.
 *
 * A note written through the CMS (`noteWritten`, called by the one function
 * that writes notes) is delivered instead as one message,
 * `inkbrush:notes-saved` with the written files (project-relative, as a
 * page's `meta.file`), at the moment the content layer's reload would have
 * gone out: then the page, its frontmatter and an `.md` note's rendering are
 * all current. Each page decides what to do with it (client/content-updates.ts).
 * The note's module update is taken here: its server modules are
 * invalidated, as Astro's HMR would, and nothing is sent for it.
 *
 * A change the CMS did not make (an editor, git) reloads the pages as before.
 */
import { relative } from 'node:path';

import type { Plugin, RunnableDevEnvironment } from 'vite';

/** a path as Vite writes it: forward slashes */
const vitePath = (file: string) => file.replaceAll('\\', '/');

/** absolute paths of notes written through the CMS whose content-layer reload has not gone out yet */
const written = new Set<string>();

/** records that the CMS wrote the note at `file` (absolute path) */
export function noteWritten(file: string): void {
  written.add(vitePath(file));
}

/** the Vite plugin delivering notes written through the CMS as `inkbrush:notes-saved` */
export function contentUpdatePlugin(): Plugin {
  return {
    name: 'astro-inkbrush:content-updates',
    hotUpdate: {
      order: 'pre',
      handler({ file, modules, timestamp }) {
        if (!written.has(file)) return;
        if (this.environment.name !== 'client') {
          const invalidated = new Set<(typeof modules)[number]>();
          for (const mod of modules) this.environment.moduleGraph.invalidateModule(mod, invalidated, timestamp, true);
          // a runnable environment also keeps the modules it evaluated
          const runner = 'runner' in this.environment ? (this.environment as RunnableDevEnvironment).runner : undefined;
          for (const mod of invalidated) {
            const evaluated = mod.id ? runner?.evaluatedModules.getModuleById(mod.id) : undefined;
            if (evaluated) runner!.evaluatedModules.invalidateModule(evaluated);
          }
        }
        return [];
      },
    },
    configureServer(server) {
      const hot = server.environments.client.hot;
      const send = hot.send.bind(hot) as (...args: unknown[]) => void;
      // the content layer's reload: a full reload of every path, carrying no module
      hot.send = ((...args: unknown[]) => {
        const [payload] = args;
        const contentReload =
          typeof payload === 'object' && payload !== null && (payload as { type?: string }).type === 'full-reload' && (payload as { path?: string }).path === '*';
        if (!contentReload || written.size === 0) return send(...args);
        const files = [...written].map((file) => vitePath(relative(server.config.root, file)));
        written.clear();
        return send({ type: 'custom', event: 'inkbrush:notes-saved', data: { files } });
      }) as typeof hot.send;
    },
  };
}
