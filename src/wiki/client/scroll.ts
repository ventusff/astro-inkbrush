/**
 * Scroll continuity across the full-page reload that follows a saved edit
 * (content HMR in dev, a timed reload in the playground). Deliberately free
 * of side effects: feature modules import it without waking the client
 * entry — client/index.ts boots on import, and a value import from a
 * feature chunk would mount the whole dev chrome (account chip, chat,
 * comments) as a side effect.
 */
export function rememberScroll(): void {
  sessionStorage.setItem(`wiki:scroll:${window.location.pathname}`, String(window.scrollY));
}

export function restoreScroll(): void {
  const key = `wiki:scroll:${window.location.pathname}`;
  const saved = sessionStorage.getItem(key);
  if (saved !== null) {
    sessionStorage.removeItem(key);
    window.scrollTo({ top: Number(saved) });
  }
}
