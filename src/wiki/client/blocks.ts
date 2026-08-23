/**
 * Block discovery + the floating edit handle (Notion-style gutter).
 *
 * rehype-wiki-blocks stamped every top-level block: markdown blocks carry
 * `data-wiki-src="start-end"` themselves; JSX components are preceded by an
 * invisible `<template data-wiki-src … data-wiki-jsx>` anchor bound here to
 * its next element sibling; the frontmatter's `<template data-wiki-src …
 * data-wiki-frontmatter>` anchor binds to the site's
 * `[data-inkbrush-slot="frontmatter"]` element — the page head, meta strip
 * or whatever the layout renders from the frontmatter (no slot, no
 * frontmatter block: a heading guessed from the page could be a stamped
 * body block already). One shared handle (a toolbar) follows the active
 * block; ✎ opens the in-place source editor, ✦ opens the Claude popover
 * (markdown blocks only), ⟲ opens the revision-history popover (view diffs /
 * one-click revert).
 *
 * Activation paths: hovering a block (fine pointer), tapping a block (coarse
 * pointer), or focusing a block / a control inside it (keyboard). Keyboard
 * model: the blocks share one roving tab stop — Tab enters the block layer
 * once, ↑/↓ move between blocks, Enter moves focus into the toolbar (whose
 * buttons rove the same way with ←/→/↑/↓), Escape returns it. Host-set
 * tabindex / aria-describedby values are preserved and restored on unmount.
 */
import { aiAvailability, currentUser, onAuthChange } from './auth';
import type { PageContext } from './index';
import { S } from './strings';
import { h, icon, toast } from './ui';

export interface BlockRef {
  el: HTMLElement;
  start: number;
  end: number;
  /** component name when the block is a JSX island (Hero, DemoMount, …) */
  jsx: string | null;
  /** the note's frontmatter (YAML), bound to the page head */
  frontmatter: boolean;
}

/** the element the frontmatter anchor binds to: the site's declared slot */
function frontmatterHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-inkbrush-slot="frontmatter"]');
}

function collectBlocks(): BlockRef[] {
  const refs: BlockRef[] = [];
  const seen = new Set<HTMLElement>();
  for (const node of document.querySelectorAll<HTMLElement>('[data-wiki-src]')) {
    const range = node.dataset['wikiSrc']!;
    const [start, end] = range.split('-').map(Number);
    if (!start || !end) continue;
    let el: HTMLElement | null;
    let jsx: string | null = null;
    let frontmatter = false;
    if (node.tagName === 'TEMPLATE' && 'wikiFrontmatter' in node.dataset) {
      frontmatter = true;
      el = frontmatterHost();
    } else if (node.tagName === 'TEMPLATE') {
      jsx = node.dataset['wikiJsx'] ?? 'component';
      el = node.nextElementSibling as HTMLElement | null;
      // skip fellow anchors (two adjacent JSX components)
      while (el?.tagName === 'TEMPLATE') el = el.nextElementSibling as HTMLElement | null;
    } else {
      el = node;
    }
    if (!el || seen.has(el)) continue;
    seen.add(el);
    refs.push({ el, start, end, jsx, frontmatter });
  }
  return refs;
}

export function mountBlocks(ctx: PageContext): void {
  const blocks = collectBlocks();
  if (blocks.length === 0) return;

  const byEl = new Map(blocks.map((b) => [b.el, b]));
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  let active: BlockRef | null = null;
  let editing = false;

  // host attribute values, restored verbatim on unmount
  const savedAttrs = new Map<HTMLElement, { tabindex: string | null; describedby: string | null }>();
  const hint = h('span', { id: 'wiki-block-hint', class: 'wiki-sr-only' }, S.blocks.focusHint);
  for (const block of blocks) {
    savedAttrs.set(block.el, {
      tabindex: block.el.getAttribute('tabindex'),
      describedby: block.el.getAttribute('aria-describedby'),
    });
    block.el.classList.add('wiki-block');
    // the hint joins (never replaces) a host-provided description
    const described = block.el.getAttribute('aria-describedby');
    block.el.setAttribute('aria-describedby', described ? `${described} ${hint.id}` : hint.id);
  }

  // Roving tab stop over the blocks: exactly one block is in the tab order at
  // a time; the stop follows the active block, ↑/↓ move it (see keydown).
  let tabStop: BlockRef = blocks[0]!;
  for (const block of blocks) block.el.tabIndex = block === tabStop ? 0 : -1;
  const setTabStop = (block: BlockRef): void => {
    if (block === tabStop) return;
    tabStop.el.tabIndex = -1;
    tabStop = block;
    block.el.tabIndex = 0;
  };

  const editBtn = h(
    'button',
    { type: 'button', 'aria-label': S.blocks.edit, title: S.blocks.edit },
    icon('pencil'),
  );
  const aiBtn = h(
    'button',
    {
      type: 'button',
      class: 'ai',
      'aria-label': S.blocks.ai,
      title: S.blocks.ai,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    },
    icon('sparkle'),
  );
  const historyBtn = h(
    'button',
    {
      type: 'button',
      'aria-label': S.blocks.history,
      title: S.blocks.history,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    },
    icon('history'),
  );
  const handle = h(
    'div',
    { class: 'wiki-handle', role: 'toolbar', 'aria-label': S.blocks.toolbar, inert: true },
    editBtn,
    aiBtn,
    historyBtn,
  );
  document.body.append(hint, handle);

  // Roving tab stop inside the toolbar (arrow keys move focus, so only one
  // button sits in the tab order).
  const allButtons = [editBtn, aiBtn, historyBtn];
  const focusToolbarButton = (btn: HTMLButtonElement): void => {
    for (const b of allButtons) b.tabIndex = b === btn ? 0 : -1;
    btn.focus();
  };
  for (const b of allButtons) b.tabIndex = b === editBtn ? 0 : -1;

  // revision history is editor-only on the server: the control exists only
  // for signed-in users. The ✦ exists only where the deployment can run
  // claude jobs (/me.ai — absent means yes), and never on the frontmatter
  // block — the block-edit job revises prose, not YAML.
  const syncAvailability = (): void => {
    historyBtn.hidden = !currentUser();
    aiBtn.hidden = aiAvailability() === 'off' || active?.frontmatter === true;
    if ((historyBtn.hidden && historyBtn.tabIndex === 0) || (aiBtn.hidden && aiBtn.tabIndex === 0)) {
      historyBtn.tabIndex = -1;
      aiBtn.tabIndex = -1;
      editBtn.tabIndex = 0;
    }
  };
  syncAvailability();
  onAuthChange(syncAvailability);

  const hideHandle = (): void => {
    handle.classList.remove('show');
    handle.inert = true;
    active?.el.classList.remove('wiki-block-hover');
    active = null;
  };

  /**
   * Sticky-chrome clamp — the handle must never slide underneath the site's
   * sticky header. Contract: an explicit `[data-inkbrush-sticky]` marker
   * wins; the `.site-nav` class fallback exists for sites that declare no
   * marker. Neither present → no clamp.
   */
  const navBottom = (): number => {
    const nav =
      document.querySelector('[data-inkbrush-sticky]') ?? document.querySelector('.site-nav');
    return nav ? nav.getBoundingClientRect().bottom : 0;
  };

  /**
   * Fine pointer: the handle sits in the gutter at the block's top-left.
   * Coarse pointer: a horizontal bar hugging the block's top-right corner.
   * Both are clamped into the viewport: a long block scrolled past its start
   * pins the handle below the sticky chrome; an approaching block end lifts
   * it. Returns false when the block has no visible room for the handle.
   */
  const positionHandle = (block: BlockRef): boolean => {
    const rect = block.el.getBoundingClientRect();
    const coarse = coarsePointer.matches;
    handle.setAttribute('aria-orientation', coarse ? 'horizontal' : 'vertical');
    const height = handle.offsetHeight || (coarse ? 40 : 62);
    const minTop = navBottom() + 6;
    if (rect.bottom < minTop + height + 4 || rect.top > window.innerHeight - 24) return false;
    let top = Math.max(rect.top + 2, minTop);
    top = Math.min(top, rect.bottom - height - 2);
    handle.style.top = `${top}px`;
    if (coarse) {
      const width = handle.offsetWidth || 112;
      handle.style.left = `${Math.max(6, Math.min(rect.right - width, window.innerWidth - width - 6))}px`;
    } else {
      handle.style.left = `${Math.max(6, rect.left - 40)}px`;
    }
    return true;
  };

  const showHandle = (block: BlockRef): void => {
    if (editing) return;
    active?.el.classList.remove('wiki-block-hover');
    active = block;
    setTabStop(block);
    syncAvailability();
    block.el.classList.add('wiki-block-hover');
    if (positionHandle(block)) {
      handle.classList.add('show');
      handle.inert = false;
    } else {
      hideHandle();
    }
  };

  /** nearest bound block containing the node */
  const blockOf = (node: EventTarget | null): BlockRef | null => {
    let el = node instanceof Element ? node : null;
    while (el && !byEl.has(el as HTMLElement)) el = el.parentElement;
    return el ? (byEl.get(el as HTMLElement) ?? null) : null;
  };

  // Document-level listeners are registered through `listen` so unmount (HMR
  // dispose) can remove every one of them.
  const documentListeners: Array<
    [string, EventListener, AddEventListenerOptions | undefined]
  > = [];
  const listen = <K extends keyof DocumentEventMap>(
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    document.addEventListener(type, fn as EventListener, opts);
    documentListeners.push([type, fn as EventListener, opts]);
  };

  listen('mouseover', (e) => {
    if (editing || handle.contains(e.target as Node)) return;
    const block = blockOf(e.target);
    if (block && block !== active) showHandle(block);
  });

  // coarse pointer: a tap on a block shows its toolbar, a tap elsewhere hides it
  listen('pointerup', (e) => {
    if (editing || e.pointerType !== 'touch' || handle.contains(e.target as Node)) return;
    const block = blockOf(e.target);
    if (block) {
      if (block !== active) showHandle(block);
    } else {
      hideHandle();
    }
  });

  // keyboard: focus inside a block shows its toolbar; focus elsewhere hides it
  // (a popover opened from the toolbar keeps it, so focus can return to it)
  listen('focusin', (e) => {
    if (editing) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (handle.contains(target) || target.closest('.wiki-popover')) return;
    const block = blockOf(target);
    if (block) {
      if (block !== active) showHandle(block);
    } else {
      hideHandle();
    }
  });

  const toolbarButtons = (): HTMLButtonElement[] => allButtons.filter((b) => !b.hidden);

  listen('keydown', (e) => {
    if (editing || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (handle.contains(target)) {
      const buttons = toolbarButtons();
      const index = buttons.indexOf(target as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
        next = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (e.key === 'Home') next = buttons[0];
      else if (e.key === 'End') next = buttons[buttons.length - 1];
      else if (e.key === 'Escape') {
        e.preventDefault();
        active?.el.focus();
        return;
      }
      if (next) {
        e.preventDefault();
        focusToolbarButton(next);
      }
      return;
    }
    if (!byEl.has(target)) return;
    // ↑/↓ on a block element move the roving tab stop to its neighbor
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const index = blocks.indexOf(byEl.get(target)!);
      const next = blocks[index + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        e.preventDefault();
        next.el.focus();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const block = byEl.get(target)!;
      if (block !== active) showHandle(block);
      if (block === active) {
        e.preventDefault();
        const first = toolbarButtons()[0];
        if (first) focusToolbarButton(first);
      }
    }
  });

  listen(
    'scroll',
    () => {
      if (!active || editing) return;
      // follow the active block while scrolling; hide once it leaves view
      if (!positionHandle(active)) hideHandle();
    },
    { passive: true },
  );

  const requireLogin = (): boolean => {
    if (currentUser()) return true;
    toast(S.blocks.signInFirst, 'err');
    return false;
  };

  editBtn.addEventListener('click', async () => {
    if (!active || !requireLogin()) return;
    const block = active;
    hideHandle();
    editing = true;
    try {
      const { openEditor } = await import('./editor');
      openEditor(ctx, block, () => {
        editing = false;
        block.el.focus();
      });
    } catch (err) {
      // a failed lazy load must never brick the handles for the session
      editing = false;
      console.error('[wiki] editor module failed to load:', err);
      toast(S.blocks.editorLoadFailed, 'err');
    }
  });

  aiBtn.addEventListener('click', async () => {
    if (!active || !requireLogin()) return;
    const block = active;
    try {
      const { openAiPopover } = await import('./ai-popover');
      openAiPopover(ctx, block, handle, aiBtn);
    } catch (err) {
      console.error('[wiki] ai popover failed to load:', err);
      toast(S.blocks.aiLoadFailed, 'err');
    }
  });

  historyBtn.addEventListener('click', async () => {
    if (!active || !requireLogin()) return;
    const block = active;
    try {
      const { openHistory } = await import('./history');
      await openHistory(ctx, block, handle, historyBtn);
    } catch (err) {
      console.error('[wiki] history panel failed to load:', err);
      toast(S.blocks.historyLoadFailed, 'err');
    }
  });

  // Unmount: drop the document listeners, remove the injected chrome and
  // restore every host attribute this mount touched.
  const unmount = (): void => {
    for (const [type, fn, opts] of documentListeners) document.removeEventListener(type, fn, opts);
    handle.remove();
    hint.remove();
    for (const block of blocks) {
      block.el.classList.remove('wiki-block', 'wiki-block-hover');
      const saved = savedAttrs.get(block.el)!;
      if (saved.tabindex === null) block.el.removeAttribute('tabindex');
      else block.el.setAttribute('tabindex', saved.tabindex);
      if (saved.describedby === null) block.el.removeAttribute('aria-describedby');
      else block.el.setAttribute('aria-describedby', saved.describedby);
    }
  };
  import.meta.hot?.dispose(unmount);
}
