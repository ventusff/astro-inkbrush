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
import type { NoteMeta, WikiUser } from '../shared/types';
import {
  createLocalBackend,
  type PlaygroundManifest,
  type ManifestNote,
} from './backend';
import { applyOverlayToDom, buildOverlay, disableJsxAnchors, stampedElements } from './overlay';
import { createRenderer } from './render';
import { getIdentity, getOverrides } from './store';
import type { PlaygroundConfig } from './index';

import '../client/wiki.css';

/** scroll restore across the reload that follows a saved edit (the same
 *  sessionStorage key the dev client uses) */
function restoreScroll(): void {
  const key = `wiki:scroll:${window.location.pathname}`;
  const saved = sessionStorage.getItem(key);
  if (saved !== null) {
    sessionStorage.removeItem(key);
    window.scrollTo({ top: Number(saved) });
  }
}

export interface Activation {
  note: ManifestNote;
  editedSegments: number;
}

export async function activate(config: PlaygroundConfig, noteId: string): Promise<Activation | null> {
  const res = await fetch(config.manifestUrl);
  if (!res.ok) return null;
  const manifest = (await res.json()) as PlaygroundManifest;
  const note = manifest.notes.find((n) => n.id === noteId);
  if (!note) return null;

  const siteConfig = config.configure(manifest);
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
  const meta = await api.get<NoteMeta>(`/meta/${note.id}`);
  mountBlocks({ meta });

  return { note, editedSegments: overlay.segments.filter((s) => s.edited).length };
}
