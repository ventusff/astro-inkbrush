/**
 * Playground activation — the heavy half, loaded on demand by index.ts
 * (returning visitors with local edits, or a first click on the badge):
 * fetch the manifest, reconstruct the overlay, install the browser-local
 * transport, and mount the ordinary block-editing client on top of it.
 */
import { buildWikilinkResolver } from '../../lib/wikilinks.ts';
import { api, setWikiTransport } from '../client/api';
import { primeSession } from '../client/auth';
import { mountBlocks } from '../client/blocks';
import { restoreScroll } from '../client/scroll';
import type { NoteMeta, WikiUser } from '../shared/types';
import {
  createLocalBackend,
  type PlaygroundManifest,
  type ManifestNote,
} from './backend';
import { applyOverlayToDom, buildOverlay, rangeOf, stampedNodes } from './overlay';
import { createRenderer } from './render';
import { getIdentity, getOverrides } from './store';
import { DEFAULT_STRINGS, type PlaygroundConfig } from './index';

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

export interface Activation {
  note: ManifestNote;
  editedSegments: number;
}

export async function activate(config: PlaygroundConfig, noteId: string): Promise<Activation | null> {
  injectStyles();
  const res = await fetch(config.manifestUrl);
  if (!res.ok) return null;
  const manifest = (await res.json()) as PlaygroundManifest;
  const note = manifest.notes.find((n) => n.id === noteId);
  if (!note) return null;

  const siteConfig = await config.configure(manifest);
  const guestName = (await getIdentity())?.name ?? config.guestName ?? 'Playground visitor';
  const guest: WikiUser = {
    name: guestName,
    email: 'visitor@playground.local',
    provider: 'dev',
  };

  const resolve = buildWikilinkResolver({
    notes: () =>
      manifest.notes.map(({ id, title, brand, aliases }) => ({ id, title, brand, aliases })),
    urlFor: siteConfig.urlFor,
    locales: manifest.locales.map(({ code, prefix }) => ({ code, prefix })),
  });
  const renderer = createRenderer({
    site: siteConfig.site,
    wikilinks: { resolve, ...(siteConfig.noteIdOf ? { noteIdOf: siteConfig.noteIdOf } : {}) },
  });

  // stamps — markdown elements and JSX anchors alike (component blocks edit
  // at the source level, exactly like dev)
  const nodes = stampedNodes();
  const ranges = nodes.map((el) => rangeOf(el) ?? { start: 0, end: 0, jsx: null });
  const overrides = (await getOverrides(noteId))?.segments ?? {};
  const overlay = buildOverlay(note.source, ranges, overrides);
  if (!overlay) return null;

  const strings = { ...DEFAULT_STRINGS, ...config.strings };
  await applyOverlayToDom(
    overlay,
    nodes,
    (source, curStart) => renderer.renderBlock(source, curStart, `/${note.file}`),
    { jsxEditedNote: strings.jsxEditedNote },
  );

  setWikiTransport(
    createLocalBackend({
      manifest,
      note,
      overlay,
      renderer,
      guest,
      site: siteConfig.site,
      ...(siteConfig.guard ? { guard: siteConfig.guard } : {}),
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
  const { toast } = await import('../client/ui');
  toast(strings.activeHint);

  return { note, editedSegments: overlay.segments.filter((s) => s.edited).length };
}
