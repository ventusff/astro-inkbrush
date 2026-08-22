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
  '.cm-content': { padding: '12px 4px', caretColor: 'var(--wiki-accent, #b6552e)' },
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
  const errorBox = h('div', { class: 'wiki-editor-error', style: { display: 'none' } });
  const saveBtn = h('button', { class: 'wiki-btn wiki-btn-primary' }, S.editor.save);
  const cancelBtn = h('button', { class: 'wiki-btn' }, S.editor.cancel);
  const cmHost = h('div', { class: 'wiki-editor-cm' });

  const shell = h(
    'div',
    { class: 'wiki-editor' },
    h(
      'div',
      { class: 'wiki-editor-head' },
      h('span', {}, S.editor.title(block.jsx)),
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
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewSeq = 0;
  const refreshPreview = (source: string): void => {
    if (hasJsx(source)) {
      previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.jsxNoPreview(block.jsx)));
      return;
    }
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const seq = ++previewSeq;
      try {
        // Previewing the author's own note source: any raw HTML in it is the
        // author's. The server sanitizes by default, so request raw explicitly
        // to keep the preview identical to the real render.
        const { html } = await api.post<{ html: string }>('/render', {
          markdown: source,
          sanitize: false,
        });
        if (seq !== previewSeq) return;
        if (html.trim()) previewBody.innerHTML = html;
        else previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.empty));
      } catch {
        /* preview is best-effort */
      }
    }, 350);
  };

  /* ---- editor ---- */
  const close = (): void => {
    view.destroy();
    shell.remove();
    block.el.style.removeProperty('display');
    activeCleanup = null;
    onClose();
  };

  const save = (): boolean => {
    void (async () => {
      const source = view.state.doc.toString();
      saveBtn.setAttribute('disabled', '');
      saveBtn.textContent = S.editor.validating;
      errorBox.style.display = 'none';
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
        // astro content HMR reloads the page; belt-and-braces fallback:
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        saveBtn.removeAttribute('disabled');
        saveBtn.textContent = S.editor.save;
        const message = err instanceof ApiError ? err.message : S.editor.saveFailed;
        errorBox.textContent = message;
        errorBox.style.display = '';
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
