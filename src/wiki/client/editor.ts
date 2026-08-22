/**
 * In-place block editor: the rendered block collapses and a CodeMirror source
 * editor (with a live server-rendered preview) expands in its place —
 * Wikipedia section editing, one block at a time.
 *
 * Save = PUT /block (optimistic lock via slice hash + whole-file MDX compile
 * gate on the server). On success astro's content HMR reloads the page; we
 * remember the scroll position so the reader doesn't lose their place.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, keymap, placeholder } from '@codemirror/view';

import type { BlockSource } from '../shared/types';
import { wikilinkCompletion } from './autocomplete';
import { api, ApiError } from './api';
import type { BlockRef } from './blocks';
import type { PageContext } from './index';
import { rememberScroll } from './index';
import { S } from './strings';
import { h, toast } from './ui';

let activeCleanup: (() => void) | null = null;

const cmTheme = EditorView.theme({
  '&': { fontSize: '13.5px' },
  '.cm-content': { padding: '12px 4px', caretColor: 'var(--wiki-accent)' },
  '.cm-line': { padding: '0 12px' },
});

/** does this block's source contain a JSX component tag? (no preview then) */
function hasJsx(source: string): boolean {
  return /<[A-Z][\w]*[\s/>]/.test(source);
}

export function openEditor(ctx: PageContext, block: BlockRef, onClose: () => void): void {
  activeCleanup?.();
  void openEditorInner(ctx, block, onClose);
}

async function openEditorInner(ctx: PageContext, block: BlockRef, onClose: () => void): Promise<void> {
  let initial: BlockSource;
  try {
    initial = await api.get<BlockSource>(
      `/block/${ctx.meta.id}?start=${block.start}&end=${block.end}`,
    );
  } catch (err) {
    toast(err instanceof Error ? err.message : S.editor.readFailed, 'err');
    onClose();
    return;
  }

  const previewBody = h('div', { class: 'wiki-editor-preview' });
  const errorBox = h('div', { class: 'wiki-editor-error', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'wiki-btn wiki-btn-primary' }, S.editor.save);
  const cancelBtn = h('button', { type: 'button', class: 'wiki-btn' }, S.editor.cancel);
  const cmHost = h('div', { class: 'wiki-editor-cm' });
  const title = S.editor.title(block.jsx);

  const shell = h(
    'div',
    { class: 'wiki-editor', role: 'region', 'aria-label': title },
    h(
      'div',
      { class: 'wiki-editor-head' },
      h('span', {}, title),
      h('span', { class: 'spacer' }),
      h('span', {}, `${ctx.meta.file} · L${block.start}–${block.end}`),
    ),
    previewBody,
    cmHost,
    errorBox,
    h(
      'div',
      { class: 'wiki-editor-foot' },
      h('span', { class: 'hint' }, S.editor.shortcutHint),
      cancelBtn,
      saveBtn,
    ),
  );

  /* ---- live preview (server-rendered, debounced) ---- */
  // Every edit advances the generation and cancels the pending debounce and
  // the in-flight render, so only the newest source can reach the preview.
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewGeneration = 0;
  let previewRequest: AbortController | null = null;
  const cancelPreview = (): void => {
    previewGeneration += 1;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewRequest?.abort();
    previewRequest = null;
  };
  const refreshPreview = (source: string): void => {
    cancelPreview();
    const generation = previewGeneration;
    if (hasJsx(source)) {
      previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.jsxNoPreview(block.jsx)));
      return;
    }
    previewTimer = setTimeout(async () => {
      const request = new AbortController();
      previewRequest = request;
      try {
        // Previewing the author's own note source: any raw HTML in it is the
        // author's. The server sanitizes by default, so request raw explicitly
        // to keep the preview identical to the real render. `note` resolves
        // wikilinks relative to this note's locale.
        const { html } = await api.post<{ html: string }>(
          '/render',
          { markdown: source, sanitize: false, note: ctx.meta.id },
          { signal: request.signal },
        );
        if (generation !== previewGeneration) return;
        if (html.trim()) previewBody.innerHTML = html;
        else previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.empty));
      } catch (err) {
        // an aborted request carries a bumped generation; anything else is a
        // real failure and replaces the (now stale) preview with the error
        if (generation !== previewGeneration) return;
        const message =
          err instanceof ApiError ? `${S.editor.previewFailed} — ${err.message}` : S.editor.previewFailed;
        previewBody.replaceChildren(h('div', { class: 'preview-error' }, message));
      } finally {
        if (previewRequest === request) previewRequest = null;
      }
    }, 350);
  };

  /* ---- editor ---- */
  // The host block's own inline display value, restored verbatim on close.
  const hostDisplay = block.el.style.getPropertyValue('display');
  const hostDisplayPriority = block.el.style.getPropertyPriority('display');

  // While a save is in flight, Mod-Enter cannot start another one and
  // Escape / Cancel cannot tear the editor down under the pending PUT.
  let saving = false;

  const close = (): void => {
    if (saving) return;
    cancelPreview();
    view.destroy();
    shell.remove();
    if (hostDisplay) block.el.style.setProperty('display', hostDisplay, hostDisplayPriority);
    else block.el.style.removeProperty('display');
    activeCleanup = null;
    onClose();
  };

  const save = (): boolean => {
    if (saving) return true;
    saving = true;
    void (async () => {
      const source = view.state.doc.toString();
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = S.editor.validating;
      errorBox.hidden = true;
      try {
        await api.put(`/block/${ctx.meta.id}`, {
          start: initial.start,
          end: initial.end,
          hash: initial.hash,
          source,
        });
        rememberScroll();
        saveBtn.textContent = S.editor.savedReloading;
        toast(S.editor.saved);
        // astro content HMR reloads the page; the timed reload covers the
        // case where HMR does not fire
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        saving = false;
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = S.editor.save;
        const message = err instanceof ApiError ? err.message : S.editor.saveFailed;
        errorBox.textContent = message;
        errorBox.hidden = false;
        if (err instanceof ApiError && err.status === 409) toast(message, 'err');
      }
    })();
    return true;
  };

  const view = new EditorView({
    doc: initial.source,
    parent: cmHost,
    extensions: [
      history(),
      keymap.of([
        { key: 'Mod-Enter', run: () => save() },
        { key: 'Escape', run: () => (close(), true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown(),
      wikilinkCompletion(),
      EditorView.lineWrapping,
      cmTheme,
      EditorView.contentAttributes.of({ 'aria-label': title }),
      placeholder(S.editor.placeholder),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) refreshPreview(update.state.doc.toString());
      }),
    ],
  });

  saveBtn.addEventListener('click', () => save());
  cancelBtn.addEventListener('click', close);

  block.el.style.display = 'none';
  block.el.insertAdjacentElement('afterend', shell);
  refreshPreview(initial.source);
  view.focus();
  shell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  activeCleanup = close;
}
