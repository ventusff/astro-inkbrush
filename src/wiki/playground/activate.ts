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
import { applyOverlayToDom, buildOverlay, disableJsxAnchors, stampedElements } from './overlay';
import { createRenderer } from './render';
import { getIdentity, getOverrides } from './store';
import { DEFAULT_STRINGS, type PlaygroundConfig } from './index';

// The CMS stylesheet travels INSIDE this chunk as a string and is injected
// at activation. A bare `import '../client/wiki.css'` is only honoured by
// the dev server: a static host's build collects page-graph CSS at build
// time and gives a lazily imported chunk's stylesheet to no page — the
// editor chrome then renders as raw unstyled markup.
import wikiCss from '../client/wiki.css?inline';

function injectStyles(): void {
  if (document.getElementById('inkbrush-playground-style')) return;
  const el = document.createElement('style');
  el.id = 'inkbrush-playground-style';
  el.textContent = wikiCss;
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

  // stamps: strip the JSX anchors first (read-only here), then collect
  disableJsxAnchors();
  const elements = stampedElements();
  const ranges = elements.map((el) => {
    const [start, end] = (el.dataset['wikiSrc'] ?? '').split('-').map(Number);
    return { start: start ?? 0, end: end ?? 0 };
  });
  const overrides = (await getOverrides(noteId))?.segments ?? {};
  const overlay = buildOverlay(note.source, ranges, overrides);
  if (!overlay) return null;

  await applyOverlayToDom(overlay, elements, (source, curStart) =>
    renderer.renderBlock(source, curStart, `/${note.file}`),
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
  const strings = { ...DEFAULT_STRINGS, ...config.strings };
  const { toast } = await import('../client/ui');
  toast(strings.activeHint);

  return { note, editedSegments: overlay.segments.filter((s) => s.edited).length };
}
