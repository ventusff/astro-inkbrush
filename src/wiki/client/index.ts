/**
 * Wiki client entry — injected into every page by the wiki integration
 * (WIKI=1 dev mode only; the static build never includes this).
 *
 * Responsibilities: mount the session chip everywhere; on note pages,
 * activate block editing, the Claude affordances and the comment section.
 */
import './wiki.css';

import type { NoteMeta } from '../shared/types';
import { api } from './api';
import { mountAuthChip, shareAvailability } from './auth';

export interface PageContext {
  meta: NoteMeta;
}

/** Note-page discovery: the site emits <meta name="inkbrush-note"
 *  content="<note id>"> in the head of note pages — the CMS never parses
 *  the URL, so site routing stays entirely free. */
function noteIdFromPage(): string | null {
  const meta = document.querySelector('meta[name="inkbrush-note"]');
  const id = meta?.getAttribute('content')?.trim();
  return id ? id : null;
}

/** scroll restore across the HMR full-reload that follows a saved edit */
function restoreScroll(): void {
  const key = `wiki:scroll:${window.location.pathname}`;
  const saved = sessionStorage.getItem(key);
  if (saved !== null) {
    sessionStorage.removeItem(key);
    window.scrollTo({ top: Number(saved) });
  }
}

export function rememberScroll(): void {
  sessionStorage.setItem(`wiki:scroll:${window.location.pathname}`, String(window.scrollY));
}

async function init(): Promise<void> {
  // Mount guard: the entry may be evaluated more than once (Vite HMR, double
  // injection); the chrome mounts into the document exactly once.
  if (document.documentElement.dataset['inkbrushMounted']) return;
  document.documentElement.dataset['inkbrushMounted'] = '1';

  restoreScroll();
  await mountAuthChip();

  const id = noteIdFromPage();
  if (!id) return;
  let meta: NoteMeta;
  try {
    meta = await api.get<NoteMeta>(`/meta/${id}`);
  } catch {
    return; // not a note page (landing, inbox index, …)
  }
  const ctx: PageContext = { meta };

  // feature modules load lazily so the base bundle stays light
  const { mountBlocks } = await import('./blocks');
  mountBlocks(ctx);
  const { mountChatPanel } = await import('./chat-panel');
  mountChatPanel(ctx);
  const { mountComments } = await import('./comments');
  mountComments(ctx);
  // share module (config-driven): off ⇒ the module isn't even loaded
  if (shareAvailability() !== 'off') {
    const { mountShare } = await import('./share');
    mountShare(ctx);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}
