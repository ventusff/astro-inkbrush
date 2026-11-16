/**
 * In-place block editor: the rendered block collapses and a CodeMirror source
 * editor (with a live server-rendered preview) expands in its place —
 * Wikipedia section editing, one block at a time. The frontmatter block
 * edits as YAML (no preview: the page head re-renders from it after save);
 * component blocks have no preview either.
 *
 * A block on a slide (inside an element carrying `data-deck-canvas`, the
 * slide's canvas, whose slide carries `data-deck-slide`) is edited in a panel
 * docked beside the slide instead: the slide is a fixed-size scaled canvas,
 * too small for an editor and clipped while presented. The panel previews
 * the whole slide as the slide shows it — a copy of the slide element, the
 * edited block's rendering in place of the block, scaled to the panel's
 * width; the site's appearance layer styles it exactly as it styles the
 * slide.
 *
 * The editor owns the keys pressed in it: none reaches the page's own
 * shortcuts (a presented slide's keys among them), and Escape closes it.
 *
 * Save = PUT /block (optimistic lock via slice hash + whole-file MDX compile
 * gate on the server). On success astro's content HMR reloads the page; the
 * scroll position is remembered so the reader doesn't lose their place.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { EditorView, keymap, placeholder } from '@codemirror/view';

import type { BlockSource } from '../shared/types';
import { noteCompletion } from './autocomplete';
import { api, ApiError } from './api';
import type { BlockRef } from './blocks';
import type { PageContext } from './index';
import { rememberScroll } from './scroll';
import { errorText, S } from './strings';
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
    toast(errorText(err, S.editor.readFailed), 'err');
    onClose();
    return;
  }

  const previewBody = h('div', { class: 'wiki-editor-preview' });
  const errorBox = h('div', { class: 'wiki-editor-error', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'wiki-btn wiki-btn-primary' }, S.editor.save);
  const cancelBtn = h('button', { type: 'button', class: 'wiki-btn' }, S.editor.cancel);
  const cmHost = h('div', { class: 'wiki-editor-cm' });
  const title = block.frontmatter ? S.editor.frontmatterTitle : S.editor.title(block.jsx);
  const slide = block.el.closest<HTMLElement>('[data-deck-canvas]')?.closest<HTMLElement>('[data-deck-slide]') ?? null;
  // the block being edited carries `data-wiki-editing` while the editor is open, for the site's styles to read
  block.el.dataset['wikiEditing'] = '';
  const slidePreview = slide ? slideCopy(slide) : null;

  const shell = h(
    'div',
    { class: slide ? 'wiki-editor wiki-editor-docked' : 'wiki-editor', role: 'region', 'aria-label': title },
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
  /** show the rendered block: on the slide's copy when the block is on a slide, else in the preview box */
  const showPreview = (html: string): void => {
    if (slidePreview && html.trim()) {
      slidePreview.put(html);
      previewBody.replaceChildren(slidePreview.frame);
    } else if (html.trim()) previewBody.innerHTML = html;
    else previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.empty));
  };
  const refreshPreview = (source: string): void => {
    cancelPreview();
    const generation = previewGeneration;
    if (block.frontmatter) {
      previewBody.replaceChildren(h('div', { class: 'empty' }, S.editor.frontmatterNoPreview));
      return;
    }
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
        showPreview(html);
      } catch (err) {
        // an aborted request carries a bumped generation; anything else is a
        // real failure and replaces the (now stale) preview with the error
        if (generation !== previewGeneration) return;
        const message = err instanceof ApiError ? `${S.editor.previewFailed} — ${errorText(err)}` : S.editor.previewFailed;
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
    slidePreview?.dispose();
    delete block.el.dataset['wikiEditing'];
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
        const message = err instanceof ApiError ? errorText(err) : S.editor.saveFailed;
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
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      ...(block.frontmatter ? [yaml()] : [markdown(), noteCompletion(ctx)]),
      EditorView.lineWrapping,
      cmTheme,
      EditorView.contentAttributes.of({ 'aria-label': title }),
      placeholder(block.frontmatter ? S.editor.frontmatterPlaceholder : S.editor.placeholder),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) refreshPreview(update.state.doc.toString());
      }),
    ],
  });

  saveBtn.addEventListener('click', () => save());
  cancelBtn.addEventListener('click', close);
  // an Escape the editor itself took (closing its completion list) is not a close
  shell.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });

  if (slide) {
    document.body.append(shell);
    slidePreview!.fit();
  } else {
    block.el.style.display = 'none';
    block.el.insertAdjacentElement('afterend', shell);
    shell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  refreshPreview(initial.source);
  view.focus();
  activeCleanup = close;
}

/**
 * A copy of a slide for the docked editor's preview: the slide element
 * cloned as a picture of the slide (its blocks are not blocks of the page,
 * so the editor's marks on them, `wiki-block`, are dropped), the edited
 * block's place in it remembered, its canvas scaled to
 * the copy's own inner width (`--deck-k`, the scale the site's slide styles
 * read), so the whole canvas shows in whatever box the copy is laid out in.
 * `put` replaces the block's rendering on the copy; the copy's components are
 * mounted by the site's own scripts on `astro:page-load`.
 */
function slideCopy(slide: HTMLElement): {
  frame: HTMLElement;
  put(html: string): void;
  fit(): void;
  dispose(): void;
} {
  const copy = slide.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll('.wiki-block')) el.classList.remove('wiki-block');
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  const frame = h('div', { class: 'wiki-editor-slide' }, copy);
  const canvas = copy.querySelector<HTMLElement>('[data-deck-canvas]')!;
  let shown: Node[] = [copy.querySelector('[data-wiki-editing]')!];
  const [width, height] = (canvas.dataset['deckCanvas'] ?? '960x540').split('x').map(Number) as [number, number];
  copy.style.setProperty('--deck-h', `${height}px`);
  let resize: ResizeObserver | null = null;
  return {
    frame,
    put(html) {
      // `html` is never blank (showPreview), so the rendering always leaves a node to replace next time
      const parsed = document.createElement('template');
      parsed.innerHTML = html;
      const nodes = [...parsed.content.childNodes];
      const first = shown[0]!;
      first.parentNode?.insertBefore(parsed.content, first);
      for (const node of shown) node.parentNode?.removeChild(node);
      shown = nodes;
      document.dispatchEvent(new Event('astro:page-load'));
    },
    fit() {
      const scale = () => copy.style.setProperty('--deck-k', String(copy.clientWidth / width));
      resize = new ResizeObserver(scale);
      resize.observe(copy);
      scale();
    },
    dispose() {
      resize?.disconnect();
    },
  };
}
