/**
 * Block discovery + the floating edit handle (Notion-style gutter).
 *
 * rehype-wiki-blocks stamped every top-level block: markdown blocks carry
 * `data-wiki-src="start-end"` themselves; JSX components are preceded by an
 * invisible `<template data-wiki-src … data-wiki-jsx>` anchor bound here to
 * its next element sibling. One shared handle follows the hovered block;
 * ✎ opens the in-place source editor, ✦ opens the Claude popover, ⟲ opens
 * the revision-history popover (view diffs / one-click revert).
 */
import { currentUser } from './auth';
import type { PageContext } from './index';
import { S } from './strings';
import { h, icon, toast } from './ui';

export interface BlockRef {
  el: HTMLElement;
  start: number;
  end: number;
  /** component name when the block is a JSX island (Hero, DemoMount, …) */
  jsx: string | null;
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
    if (node.tagName === 'TEMPLATE') {
      jsx = node.dataset['wikiJsx'] ?? 'component';
      el = node.nextElementSibling as HTMLElement | null;
      // skip fellow anchors (two adjacent JSX components)
      while (el?.tagName === 'TEMPLATE') el = el.nextElementSibling as HTMLElement | null;
    } else {
      el = node;
    }
    if (!el || seen.has(el)) continue;
    seen.add(el);
    refs.push({ el, start, end, jsx });
  }
  return refs;
}

export function mountBlocks(ctx: PageContext): void {
  const blocks = collectBlocks();
  if (blocks.length === 0) return;

  const byEl = new Map(blocks.map((b) => [b.el, b]));
  let active: BlockRef | null = null;
  let editing = false;

  const editBtn = h('button', { title: S.blocks.edit }, icon('pencil'));
  const aiBtn = h('button', { class: 'ai', title: S.blocks.ai }, icon('sparkle'));
  const historyBtn = h('button', { class: 'hist', title: S.blocks.history }, icon('history'));
  const handle = h('div', { class: 'wiki-handle' }, editBtn, aiBtn, historyBtn);
  document.body.append(handle);

  const hideHandle = (): void => {
    handle.classList.remove('show');
    active?.el.classList.remove('wiki-block-hover');
    active = null;
  };

  /**
   * Sticky-chrome clamp — the handle must never slide underneath the site's
   * sticky header. Contract: a site marks its sticky bar with
   * `[data-inkbrush-sticky]`; a `.site-nav` element is honored as a fallback
   * convention. Neither present → no clamp.
   */
  const navBottom = (): number => {
    const nav =
      document.querySelector('[data-inkbrush-sticky]') ?? document.querySelector('.site-nav');
    return nav ? nav.getBoundingClientRect().bottom : 0;
  };

  /**
   * Place the handle at the block's top-left, clamped into the viewport:
   * long block scrolled past its start → pinned below the breadcrumb; block
   * end approaching → rides up with it. Returns false when the block has no
   * visible room for the handle.
   */
  const positionHandle = (block: BlockRef): boolean => {
    const rect = block.el.getBoundingClientRect();
    const height = handle.offsetHeight || 62;
    const minTop = navBottom() + 6;
    if (rect.bottom < minTop + height + 4 || rect.top > window.innerHeight - 24) return false;
    let top = Math.max(rect.top + 2, minTop);
    top = Math.min(top, rect.bottom - height - 2);
    handle.style.top = `${top}px`;
    handle.style.left = `${Math.max(6, rect.left - 40)}px`;
    return true;
  };

  const showHandle = (block: BlockRef): void => {
    if (editing) return;
    active?.el.classList.remove('wiki-block-hover');
    active = block;
    block.el.classList.add('wiki-block-hover');
    if (positionHandle(block)) handle.classList.add('show');
    else hideHandle();
  };

  document.addEventListener('mouseover', (e) => {
    if (editing) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (handle.contains(target)) return;
    // nearest bound ancestor block
    let el: HTMLElement | null = target;
    while (el && !byEl.has(el)) el = el.parentElement;
    if (el) {
      const block = byEl.get(el)!;
      if (block !== active) showHandle(block);
    }
  });

  document.addEventListener(
    'scroll',
    () => {
      if (!active || editing) return;
      // follow the hovered block while scrolling; hide once it leaves view
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
      openAiPopover(ctx, block, handle);
    } catch (err) {
      console.error('[wiki] ai popover failed to load:', err);
      toast(S.blocks.aiLoadFailed, 'err');
    }
  });

  // history is readable without login; the revert button checks the session
  historyBtn.addEventListener('click', async () => {
    if (!active) return;
    const block = active;
    try {
      const { openHistory } = await import('./history');
      await openHistory(ctx, block, handle);
    } catch (err) {
      console.error('[wiki] history panel failed to load:', err);
      toast(S.blocks.historyLoadFailed, 'err');
    }
  });
}
