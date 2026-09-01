/**
 * Playground activation — the heavy half, loaded on demand by index.ts
 * (returning visitors with local edits, or a first click on the badge):
 * read the page's own source, reconstruct the overlay, install the
 * browser-local transport, and mount the ordinary block-editing client on
 * top of it.
 *
 * What activation loads is what activation needs: this chunk, the page's
 * source island and the index manifest (already in flight from index.ts).
 * The site's plugin graph, the render pipeline and the editor are lazy —
 * built on the first render (an edited segment on a returning visit, the
 * editor's preview, a save) and warmed in idle time right after activation,
 * so the first edit opens at once without ever sitting on the click path.
 */
import { buildWikilinkResolver } from '../../lib/wikilink-core.ts';
import { api, setWikiTransport } from '../client/api';
import { primeSession } from '../client/auth';
import { mountBlocks } from '../client/blocks';
import { restoreScroll } from '../client/scroll';
import { toast, whenIdle } from '../client/ui';
import type { NoteMeta, WikiUser } from '../shared/types';
import { createLocalBackend, type PlaygroundManifest, type PlaygroundNote } from './backend';
import { applyOverlayToDom, buildOverlay, rangeOf, stampedNodes } from './overlay';
import { createRenderer, type RendererInputs } from './render';
import { getIdentity, getOverrides } from './store';
import { DEFAULT_STRINGS, type PlaygroundConfig, type PlaygroundSiteConfig } from './index';

// The CMS stylesheet travels INSIDE this chunk as a string and is injected
// at activation. A bare `import '../client/wiki.css'` is only honoured by
// the dev server: a static host's build collects page-graph CSS at build
// time and gives a lazily imported chunk's stylesheet to no page — the
// editor chrome then renders as raw unstyled markup.
import wikiCss from '../client/wiki.css?inline';

/* the note above an edited component block (token colors, host fallbacks) */
const PLAYGROUND_CSS = `
.pg-jsx-note {
  margin: 10px 0; padding: 8px 12px;
  border: 1px dashed var(--color-line, rgba(128,128,128,0.4));
  border-radius: 6px;
  font: 500 12px/1.5 system-ui, sans-serif;
  color: var(--color-ink-soft, color-mix(in srgb, canvastext 70%, canvas));
  background: var(--color-bg-soft, transparent);
}
`;

function injectStyles(): void {
  if (document.getElementById('inkbrush-playground-style')) return;
  const el = document.createElement('style');
  el.id = 'inkbrush-playground-style';
  el.textContent = wikiCss + PLAYGROUND_CSS;
  document.head.append(el);
}

/** the page's own source: the site emits, in the head of every note page of
 *  a playground build, `<script type="application/json" data-inkbrush-source>`
 *  holding `{ file, source }` — the note's repo-relative path and the full
 *  file text (frontmatter included), from the same build that stamped the
 *  page's blocks. Absent or malformed → the page cannot activate. */
export function noteSourceFromPage(root: Document = document): { file: string; source: string } | null {
  const island = root.querySelector('script[type="application/json"][data-inkbrush-source]');
  if (!island?.textContent) return null;
  try {
    const parsed: unknown = JSON.parse(island.textContent);
    if (parsed && typeof parsed === 'object' && 'file' in parsed && 'source' in parsed) {
      const { file, source } = parsed as { file: unknown; source: unknown };
      if (typeof file === 'string' && file && typeof source === 'string') return { file, source };
    }
  } catch {
    /* malformed island: no source */
  }
  return null;
}

export interface Activation {
  note: PlaygroundNote;
  editedSegments: number;
}

export async function activate(
  config: PlaygroundConfig,
  noteId: string,
  manifest: Promise<PlaygroundManifest>,
): Promise<Activation | null> {
  injectStyles();
  const page = noteSourceFromPage();
  if (!page) return null;
  const note: PlaygroundNote = { id: noteId, file: page.file, mdx: page.file.endsWith('.mdx') };

  // the site's inputs, built once and only when a render or a save asks
  let siteConfig: Promise<PlaygroundSiteConfig> | null = null;
  const inputs = (): Promise<PlaygroundSiteConfig> =>
    (siteConfig ??= manifest.then((m) => config.configure(m)));
  let rendererInputs: Promise<RendererInputs> | null = null;
  const renderInputs = (): Promise<RendererInputs> =>
    (rendererInputs ??= (async () => {
      const [m, site] = await Promise.all([manifest, inputs()]);
      const resolve = buildWikilinkResolver({
        notes: () => m.notes,
        urlFor: site.urlFor,
        locales: m.locales.map(({ code, prefix }) => ({ code, prefix })),
      });
      return {
        site: site.site,
        wikilinks: { resolve, ...(site.noteIdOf ? { noteIdOf: site.noteIdOf } : {}) },
      };
    })());
  const renderer = createRenderer(renderInputs);

  const [overrides, identity] = await Promise.all([getOverrides(noteId), getIdentity()]);
  const guest: WikiUser = {
    name: identity?.name ?? config.guestName ?? 'Playground visitor',
    email: 'visitor@playground.local',
    provider: 'dev',
  };

  // stamps — markdown elements, JSX anchors and the frontmatter anchor alike
  // (component blocks and the frontmatter edit at the source level, exactly
  // like dev)
  const nodes = stampedNodes();
  const ranges = nodes.map(
    (el) => rangeOf(el) ?? { start: 0, end: 0, jsx: null, frontmatter: false },
  );
  const overlay = buildOverlay(page.source, ranges, overrides?.segments ?? {});
  if (!overlay) return null;

  const strings = { ...DEFAULT_STRINGS, ...config.strings };
  await applyOverlayToDom(
    overlay,
    nodes,
    (source, first) => renderer.renderSource(source, first, `/${note.file}`),
    { jsxEditedNote: strings.jsxEditedNote, frontmatterEditedNote: strings.frontmatterEditedNote },
  );

  setWikiTransport(
    createLocalBackend({
      manifest,
      note,
      overlay,
      renderer,
      guest,
      inputs: async () => {
        const { site, guard } = await inputs();
        return { site, ...(guard ? { guard } : {}) };
      },
    }),
  );
  primeSession({
    user: guest,
    providers: { dev: false, google: 'off', googleSaml: 'off' },
    share: 'off',
    ai: 'off',
  });

  restoreScroll();
  // client/index.ts boots on import behind this once-guard; stamping it here
  // keeps any value import of the entry from mounting the dev chrome
  // (account chip, chat, comments) on top of the playground
  document.documentElement.dataset['inkbrushMounted'] = '1';
  const meta = await api.get<NoteMeta>(`/meta/${note.id}`);
  mountBlocks({ meta });

  // the block toolbar is a hover/tap affordance — say so, or the page looks
  // inert to a visitor who just clicked "try editing"
  toast(strings.activeHint);

  // the first edit previews through the site's pipeline: the plugin graph
  // and the render chunks load in idle time (the editor chunk is warmed by
  // mountBlocks), so nothing is left to fetch when the editor opens
  whenIdle(() => void renderer.warm().catch(() => undefined));

  return { note, editedSegments: overlay.segments.filter((s) => s.edited).length };
}
