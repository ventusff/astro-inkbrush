/**
 * In-place block editor: the rendered block collapses and a CodeMirror source
 * editor (with a live server-rendered preview) expands in its place —
 * Wikipedia section editing, one block at a time. The frontmatter block
 * edits as YAML (no preview: the page head re-renders from it after save).
 * A block of an MDX note previews as its page renders it: the dev server
 * compiles it with the site's MDX pipeline behind the note's own imports and
 * renders its components (POST /render-block). A block of a Markdown note
 * previews through the site's Markdown pipeline (POST /render).
 *
 * A block on a slide (inside an element carrying `data-deck-canvas`, the
 * slide's canvas, whose slide carries `data-deck-slide`) is edited in a panel
 * docked beside the slide instead: the slide is a fixed-size scaled canvas,
 * too small for an editor and clipped while presented. The panel previews
 * the whole slide as the slide shows it — a copy of the slide element, the
 * edited block's rendering in place of the block, scaled to the panel's
 * width; the site's appearance layer styles it exactly as it styles the
 * slide. While docked, the panel's width at the window's right edge is
 * `--deck-inset-inline-end` on the root element, so a presented deck fits
 * its slide beside the panel rather than under it.
 *
 * A component that declares its parameters (`data-inkbrush-props`,
 * ./prop-form.ts) gets a form for them over its source: each field rewrites
 * its attribute in the source, and the source's edits update the fields.
 *
 * The editor owns the keys pressed in it: none reaches the page's own
 * shortcuts (a presented slide's keys among them), and Escape closes it.
 *
 * Save = PUT /block (optimistic lock via slice hash + whole-file MDX compile
 * gate on the server). On success the editor stays until the page takes the
 * saved note (./content-updates.ts: in place where a component swaps its
 * part, as a deck swaps the changed slides; else by a reload, the scroll
 * kept), then closes.
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
import { propForm, propsElement, type PropSpec } from './prop-form';
import { errorText, S } from './strings';
import { h, toast } from './ui';

let activeCleanup: (() => void) | null = null;

const cmTheme = EditorView.theme({
  '&': { fontSize: '13.5px' },
  '.cm-content': { padding: '12px 4px', caretColor: 'var(--wiki-accent)' },
  '.cm-line': { padding: '0 12px' },
});

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
    previewTimer = setTimeout(async () => {
      const request = new AbortController();
      previewRequest = request;
      try {
        // Previewing the author's own note source: any raw HTML in it is the
        // author's. The server sanitizes by default, so request raw explicitly
        // to keep the preview identical to the real render. `note` resolves
        // wikilinks relative to this note's locale.
        const { html } = ctx.meta.file.endsWith('.mdx')
          ? await api.post<{ html: string }>(
              '/render-block',
              { note: ctx.meta.id, source, page: location.href },
              { signal: request.signal },
            )
          : await api.post<{ html: string }>(
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
    dock?.disconnect();
    document.documentElement.style.removeProperty('--deck-inset-inline-end');
    slidePreview?.dispose();
    delete block.el.dataset['wikiEditing'];
    if (hostDisplay) block.el.style.setProperty('display', hostDisplay, hostDisplayPriority);
    else block.el.style.removeProperty('display');
    activeCleanup = null;
    onClose();
  };

  const save = (): boolean => {
    if (saving) return true;
    const source = view.state.doc.toString();
    // the block as it is: nothing to write
    if (source === initial.source) {
      close();
      return true;
    }
    saving = true;
    void (async () => {
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
        saveBtn.textContent = S.editor.savedUpdating;
        toast(S.editor.saved);
        document.addEventListener(
          'inkbrush:content',
          () => {
            saving = false;
            close();
          },
          { once: true },
        );
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

  let props: ReturnType<typeof propForm> | null = null;
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
        if (!update.docChanged) return;
        refreshPreview(update.state.doc.toString());
        props?.sync();
      }),
    ],
  });

  const declared = propsElement(block.el)?.dataset['inkbrushProps'];
  if (declared) {
    props = propForm(JSON.parse(declared) as PropSpec[], view);
    cmHost.before(props.form);
  }

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

  let dock: ResizeObserver | null = null;
  if (slide) {
    document.body.append(shell);
    const inset = () =>
      document.documentElement.style.setProperty('--deck-inset-inline-end', `${innerWidth - shell.getBoundingClientRect().left}px`);
    dock = new ResizeObserver(inset);
    dock.observe(shell);
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

/** the box of an element around a slide copy: no box of its own, so the copy fills the preview */
const AROUND_BOX = 'display:block;position:static;inset:auto;width:auto;max-width:none;height:auto;min-height:0;margin:0;padding:0;border:0;';

/**
 * A copy of a slide for the docked editor's preview: the slide element
 * cloned as a picture of the slide (its blocks are not blocks of the page,
 * so the editor's marks on them, `wiki-block`, are dropped), the edited
 * block's place in it remembered, its canvas scaled to
 * the copy's own inner width (`--deck-k`, the scale the site's slide styles
 * read), so the whole canvas shows in whatever box the copy is laid out in.
 * The copy sits inside shallow copies of the elements around the deck
 * (`[data-deck]`), up to the body: the site's prose rules that key on them
 * (a page column's code, links, tables) reach the copy as they reach the
 * slide. They lend the copy their classes and attributes, not their boxes.
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
  let outermost: HTMLElement = copy;
  for (let el = slide.closest('[data-deck]')?.parentElement; el && el !== document.body; el = el.parentElement) {
    const around = el.cloneNode(false) as HTMLElement;
    around.removeAttribute('id');
    around.setAttribute('style', AROUND_BOX);
    around.append(outermost);
    outermost = around;
  }
  const frame = h('div', { class: 'wiki-editor-slide' }, outermost);
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
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...node.querySelectorAll('.wiki-block')]) el.classList.remove('wiki-block');
      }
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
