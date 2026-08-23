/**
 * astro-inkbrush/playground — try-it editing on a STATIC demo build, kept
 * entirely in the visitor's browser.
 *
 * This is a deliberately separate, opt-in surface for demo/debug sites
 * only. It is never part of the integration, never injected, and a build
 * that does not import it carries zero bytes of it; consumer sites keep the
 * dev-server CMS and the byte-identical static builds they have today. A
 * site that mounts it must also ship block stamps and a sources manifest
 * (see the demo of astro-inkstone for the reference wiring) and declare the
 * exception to check-dist with an explicit --allow.
 *
 * What the visitor gets: the ordinary block editor (CodeMirror, live
 * preview, save validation, revision history with revert) against a
 * browser-local backend — IndexedDB holds their per-segment edits; the
 * repo, the deployed site and other visitors never see them.
 *
 * bootPlayground() is the light entry: it seats the badge in the site's
 * chrome (the account slot; fixed corner only when no slot exists) and
 * probes IndexedDB; the pipeline + editor chunk loads only for a visitor
 * who has local edits or clicks the badge.
 */
import type { ContentGuardOptions } from '../../lib/content-guard.ts';
import type { SitePluginSet } from '../../lib/render-pipeline.ts';
import type { PlaygroundManifest } from './backend';
import { hasOverrides, resetAll } from './store';

export interface PlaygroundSiteConfig {
  /** fragment pipeline (usually the site's build plugins minus whole-document
   *  concerns — numbering, reading time; never the wikilinks plugin: the
   *  playground mounts the resolver itself from the manifest) */
  site: SitePluginSet;
  guard?: ContentGuardOptions | undefined;
  /** note id → site URL (the site's own routing rule, base included) */
  urlFor: (id: string) => string;
  /** vfile path → note id (locale-aware wikilink resolution) */
  noteIdOf?: ((path: string | undefined) => string | undefined) | undefined;
}

export interface PlaygroundStrings {
  /** chip label before activation — keep it nav-bar short */
  tryIt: string;
  /** tooltip carrying the full promise */
  tryItHint: string;
  active: string;
  /** shown next to `active` when local edits exist; #n is the count */
  edits: string;
  reset: string;
  resetConfirm: string;
  activateFailed: string;
}

const DEFAULT_STRINGS: PlaygroundStrings = {
  tryIt: 'Try editing',
  tryItHint: 'Edit this page — everything stays in your browser',
  active: 'Editing locally',
  edits: '#n local edit(s)',
  reset: 'Reset',
  resetConfirm: 'Discard every local edit on this demo (all pages)?',
  activateFailed: 'The playground could not start on this page',
};

export interface PlaygroundConfig {
  /** URL of the build-time sources manifest (base-prefixed by the site) */
  manifestUrl: string;
  /** site inputs, built once the manifest is loaded. May be async — a site
   *  should dynamic-import its pipeline here, so the boot chunk every page
   *  loads stays free of the site's plugin graph */
  configure(manifest: PlaygroundManifest): PlaygroundSiteConfig | Promise<PlaygroundSiteConfig>;
  guestName?: string | undefined;
  strings?: Partial<PlaygroundStrings> | undefined;
}

function noteIdFromPage(): string | null {
  const meta = document.querySelector('meta[name="inkbrush-note"]');
  const id = meta?.getAttribute('content')?.trim();
  return id ? id : null;
}

/* The badge docks into the site's own chrome when it can: the account
 * slot ([data-inkbrush-slot="account"]) is the CMS chip's contractual seat
 * and is unoccupied here (the playground never mounts the auth chip). In
 * the nav it is ordinary sticky-band chrome. Only a host with no slot gets
 * the fixed-corner fallback — a permanently visible overlay is a ground
 * for the text scrolling behind it, so flow placement is the default.
 * Colors are the shared token vocabulary with system-color fallbacks. */
const BADGE_CSS = `
.inkbrush-playground-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font: 500 12px/1 system-ui, sans-serif;
}
.inkbrush-playground-badge.pg-floating {
  position: fixed; right: 14px; bottom: 14px; z-index: 2147482000;
}
.inkbrush-playground-badge button {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--color-line, rgba(128,128,128,0.35));
  border-radius: 999px;
  padding: 4px 10px; cursor: pointer; white-space: nowrap;
  background: var(--color-bg-card, canvas);
  color: var(--color-ink, canvastext); font: inherit;
}
.inkbrush-playground-badge.pg-floating button {
  padding: 7px 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.12);
}
.inkbrush-playground-badge button:hover {
  background: var(--color-bg-soft, color-mix(in srgb, canvas 88%, canvastext 12%));
}
.inkbrush-playground-badge .pg-reset { padding: 4px 8px; }
@media (max-width: 520px) {
  /* narrow bars keep the glyph; the label lives on in the tooltip */
  .inkbrush-playground-badge .pg-label { display: none; }
  .inkbrush-playground-badge button { padding: 4px 7px; }
}
`;

export async function bootPlayground(config: PlaygroundConfig): Promise<void> {
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  const noteId = noteIdFromPage();
  if (!noteId) return;
  if (document.querySelector('.inkbrush-playground-badge')) return;

  const s: PlaygroundStrings = { ...DEFAULT_STRINGS, ...config.strings };

  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  document.head.append(style);

  const main = document.createElement('button');
  main.type = 'button';
  const label = document.createElement('span');
  label.className = 'pg-label';
  const setLabel = (text: string, title: string): void => {
    label.textContent = text;
    main.title = title;
  };
  main.append('✎\u00a0', label);
  setLabel(s.tryIt, s.tryItHint);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pg-reset';
  reset.textContent = s.reset;
  reset.hidden = true;
  const badge = document.createElement('div');
  badge.className = 'inkbrush-playground-badge';
  badge.append(main, reset);
  const slot = document.querySelector('[data-inkbrush-slot="account"]');
  if (slot) {
    slot.append(badge);
  } else {
    badge.classList.add('pg-floating');
    document.body.append(badge);
  }

  reset.addEventListener('click', () => {
    if (!window.confirm(s.resetConfirm)) return;
    void resetAll().then(() => window.location.reload());
  });

  let activating = false;
  let active = false;
  const start = async (): Promise<void> => {
    if (activating || active) return;
    activating = true;
    main.disabled = true;
    try {
      const { activate } = await import('./activate');
      const result = await activate(config, noteId);
      if (!result) {
        setLabel(s.activateFailed, s.activateFailed);
        return;
      }
      active = true;
      const edits =
        result.editedSegments > 0
          ? ` · ${s.edits.replace('#n', String(result.editedSegments))}`
          : '';
      setLabel(s.active + edits, s.active + edits);
      reset.hidden = false;
    } catch (err) {
      console.error('[playground] activation failed:', err);
      setLabel(s.activateFailed, s.activateFailed);
    } finally {
      main.disabled = false;
      activating = false;
    }
  };

  main.addEventListener('click', () => void start());

  // a returning visitor's edits must show without a click
  if (await hasOverrides(noteId)) void start();
}
