/**
 * astro-inkbrush/playground — try-it editing on a STATIC demo build, kept
 * entirely in the visitor's browser.
 *
 * This is a deliberately separate, opt-in surface for demo/debug sites
 * only. It is never part of the integration, never injected, and a build
 * that does not import it carries zero bytes of it; consumer sites keep the
 * dev-server CMS and the byte-identical static builds they have today.
 *
 * A site that mounts it ships four things per playground build, and
 * declares the exception to check-dist with an explicit --allow (see the
 * demo of astro-inkstone for the reference wiring):
 *
 *  - block stamps (`data-wiki-src`) — rehypeWikiBlocks in the build pipeline;
 *  - `<meta name="inkbrush-note" content="<note id>">` in each note page;
 *  - the page's own source — `<script type="application/json"
 *    data-inkbrush-source>` in the head holding `{ file, source }`, the
 *    note's repo-relative path and its full file text, from the same build
 *    as the stamps (the two can never skew);
 *  - the index manifest at `manifestUrl` — the locale table and every
 *    note's identity (id, title, brand, aliases; no sources), what wikilink
 *    resolution and the note list need.
 *
 * What the visitor gets: the ordinary block editor (CodeMirror, live
 * preview, save validation, revision history with revert) against a
 * browser-local backend — IndexedDB holds their per-segment edits; the
 * repo, the deployed site and other visitors never see them.
 *
 * bootPlayground() is the light entry: it seats the badge in the site's
 * chrome (the account slot; fixed corner only when no slot exists) and
 * probes IndexedDB. The activation chunk and the index manifest load when
 * a visitor shows intent (pointer or focus on the badge) and no later than
 * the click; the site's plugin graph and the editor load after activation,
 * in idle time. A visitor with local edits activates without a click.
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
  /** toast shown right after activation — how to reach the block toolbar */
  activeHint: string;
  /** note above an edited component block — a static page cannot re-render
   *  an Astro component, so the display degrades honestly until Reset */
  jsxEditedNote: string;
  /** note under the frontmatter slot once the frontmatter is edited — the
   *  static page head keeps the built rendering until Reset */
  frontmatterEditedNote: string;
  active: string;
  /** shown next to `active` when local edits exist; #n is the count */
  edits: string;
  reset: string;
  resetConfirm: string;
  activateFailed: string;
}

export const DEFAULT_STRINGS: PlaygroundStrings = {
  tryIt: 'Try editing',
  tryItHint: 'Edit this page — everything stays in your browser',
  activeHint: 'Hover any paragraph to edit it — on a touch screen, tap it',
  jsxEditedNote:
    'Component block edited locally — a static page cannot re-render Astro components, so the display below is a plain rendering (or the built version). Your source is kept; Reset restores the page.',
  frontmatterEditedNote:
    'Frontmatter edited locally — a static page head cannot re-render from it, so the display keeps the built version. Your YAML is kept; Reset restores the page.',
  active: 'Editing locally',
  edits: '#n local edit(s)',
  reset: 'Reset',
  resetConfirm: 'Discard every local edit on this demo (all pages)?',
  activateFailed: 'The playground could not start on this page',
};

export interface PlaygroundConfig {
  /** URL of the index manifest (base-prefixed by the site) */
  manifestUrl: string;
  /** site inputs, requested once — on the first render or save, or in the
   *  idle time after activation. May be async: a site dynamic-imports its
   *  pipeline here, so the boot chunk every page loads and the activation
   *  chunk both stay free of the site's plugin graph */
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
 * the nav it is ordinary sticky-band chrome, and flow placement is the
 * default. The fixed-corner presentation serves a host with no slot — and,
 * on narrow viewports, every host: a phone bar has no seat to give, and
 * the entry point must stay reachable, so the badge undocks to the corner
 * instead of hiding. Undocking is a real DOM move to <body> (see seat()):
 * nav chrome routinely carries backdrop-filter or transform, which makes
 * the bar the containing block of its fixed-position descendants — a badge
 * left inside the slot could never reach the viewport corner.
 * Colors are the shared token vocabulary with system-color fallbacks. */
const BADGE_CSS = `
.inkbrush-playground-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font: 500 12px/1 system-ui, sans-serif;
}
.inkbrush-playground-badge.pg-floating {
  position: fixed; right: 14px;
  bottom: calc(14px + env(safe-area-inset-bottom, 0px));
  z-index: 2147482000;
  max-width: calc(100vw - 28px);
}
.inkbrush-playground-badge button {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--color-line, rgba(128,128,128,0.35));
  border-radius: 999px;
  padding: 4px 10px; cursor: pointer; white-space: nowrap;
  background: var(--color-bg-card, canvas);
  color: var(--color-ink, canvastext); font: inherit;
}
/* No shadow on the floating pill: a fixed overlay's shadow darkens the
   ground of every text run that scrolls past it, dropping borderline text
   below AA — the opaque card face and its border carry the definition. */
.inkbrush-playground-badge.pg-floating button {
  padding: 7px 12px;
  min-width: 0;
}
.inkbrush-playground-badge button:hover {
  background: var(--color-bg-soft, color-mix(in srgb, canvas 88%, canvastext 12%));
}
.inkbrush-playground-badge .pg-label { white-space: nowrap; }
.inkbrush-playground-badge.pg-floating .pg-label { overflow: hidden; text-overflow: ellipsis; }
.inkbrush-playground-badge .pg-reset { padding: 4px 8px; flex-shrink: 0; }
/* the display rule above beats the UA's [hidden] default — restate it, or
   the reset button shows before activation */
.inkbrush-playground-badge [hidden] { display: none; }
`;

/** what a click needs, started ahead of it: the activation chunk and the
 *  index manifest */
interface Warmed {
  chunk: Promise<typeof import('./activate')>;
  manifest: Promise<PlaygroundManifest>;
}

async function fetchManifest(url: string): Promise<PlaygroundManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`playground manifest: ${res.status} ${url}`);
  return (await res.json()) as PlaygroundManifest;
}

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
  /* Responsive seat: the slot while the viewport can afford a bar seat, the
   * fixed corner otherwise — re-seated live, so a resize or rotation never
   * strands the entry point. */
  const slot = document.querySelector('[data-inkbrush-slot="account"]');
  const narrow = window.matchMedia('(max-width: 520px)');
  const seat = (): void => {
    if (slot && !narrow.matches) {
      badge.classList.remove('pg-floating');
      slot.append(badge);
    } else {
      badge.classList.add('pg-floating');
      document.body.append(badge);
    }
  };
  seat();
  narrow.addEventListener('change', seat);

  reset.addEventListener('click', () => {
    if (!window.confirm(s.resetConfirm)) return;
    void resetAll().then(() => window.location.reload());
  });

  // Intent warms the click path: the first pointer, touch or focus on the
  // badge starts the chunk and the manifest; the click then finds them in
  // flight or done. A failed warm is dropped so the click can retry it.
  let warmed: Warmed | null = null;
  const warm = (): Warmed => {
    if (!warmed) {
      const manifest = fetchManifest(config.manifestUrl);
      manifest.catch(() => undefined);
      warmed = { chunk: import('./activate'), manifest };
    }
    return warmed;
  };
  for (const type of ['pointerenter', 'touchstart', 'focus'] as const) {
    main.addEventListener(type, () => void warm(), { once: true, passive: true });
  }

  let activating = false;
  let active = false;
  const start = async (): Promise<void> => {
    if (activating || active) return;
    activating = true;
    main.disabled = true;
    try {
      const { chunk, manifest } = warm();
      const { activate } = await chunk;
      const result = await activate(config, noteId, manifest);
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
      warmed = null;
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
