/**
 * The page's side of the notes saved through the CMS (../content-updates.ts):
 * the dev server names the saved notes once their rendering is current.
 *
 * A page that shows none of them reloads, as it does for any content change.
 * A page that shows one fetches its own fresh rendering and offers it as the
 * cancelable `inkbrush:content` event on the document (`detail.doc`, the
 * fresh page as a Document). A component that takes its part of the fresh
 * page in place (a slide deck swaps the slides that changed) cancels it, and
 * the page's blocks are bound anew to the page as it now is. Offered to no
 * component, or not fetched, the page reloads, its scroll kept.
 */
import { rememberScroll } from './scroll';

/** `detail` of the `inkbrush:content` event */
export interface ContentDetail {
  /** the page as the dev server now renders it */
  doc: Document;
}

function reload(): void {
  rememberScroll();
  location.reload();
}

/**
 * Follow the notes saved through the CMS from now on. `note` is filled in
 * once the page is known to show a note: its file (`meta.file`) and how its
 * blocks are bound anew.
 */
export function followContentUpdates(): { note: { file: string; rebind: () => void } | null } {
  const page: { note: { file: string; rebind: () => void } | null } = { note: null };
  import.meta.hot?.on('inkbrush:notes-saved', async ({ files }: { files: string[] }) => {
    const note = page.note;
    if (!note || !files.includes(note.file)) return reload();
    const res = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' }).catch(() => null);
    if (!res?.ok) return reload();
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const detail: ContentDetail = { doc };
    if (document.dispatchEvent(new CustomEvent('inkbrush:content', { detail, cancelable: true }))) return reload();
    note.rebind();
  });
  return page;
}
