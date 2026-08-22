/** tiny DOM builder + shared popover primitives for the wiki chrome */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key in el && key !== 'class' && typeof value !== 'string') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key === 'class' ? 'class' : key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** svg icon factory (inline paths, 16px grid) */
export function icon(
  name: 'pencil' | 'sparkle' | 'chat' | 'close' | 'send' | 'globe' | 'history' | 'share',
): SVGElement {
  const paths: Record<string, string> = {
    pencil: 'M11.3 2.3a1 1 0 0 1 1.4 0l1 1a1 1 0 0 1 0 1.4L6 12.4l-2.8.4.4-2.8 7.7-7.7z',
    sparkle: 'M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4L8 1.5zm5 8l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z',
    chat: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.2 2.7A.5.5 0 0 1 2 13.3V3.5z',
    close: 'M4 4l8 8M12 4l-8 8',
    send: 'M2 8l12-5.5L11 14l-2.5-4.5L2 8z',
    globe: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM2 8h12M8 1.5c-4.5 4-4.5 9 0 13 4.5-4 4.5-9 0-13z',
    history: 'M2.6 3.2v3h3M2.8 6.2a5.4 5.4 0 1 1-.3 2.6M8 5v3.2l2.3 1.4',
    share: 'M8 9.6V1.9M5.4 4.3 8 1.7l2.6 2.6M3.4 7.6v5a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2v-5',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]!);
  if (name === 'close' || name === 'globe' || name === 'history' || name === 'share') {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
  } else {
    path.setAttribute('fill', 'currentColor');
  }
  svg.append(path);
  return svg;
}

/** ephemeral toast, bottom center */
export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = h('div', { class: `wiki-toast ${kind}` }, message);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 5200 : 2600);
}

/**
 * one-at-a-time floating popover, dismissed on outside click / Esc.
 * `anchor` positions it (below-end alignment, clamped to viewport).
 */
let openPopover: HTMLElement | null = null;
let closeCurrent: (() => void) | null = null;

export function popover(
  anchor: HTMLElement,
  content: HTMLElement,
  opts?: { onClose?: () => void; canDismiss?: () => boolean },
): () => void {
  dismissPopover();
  const pop = h('div', { class: 'wiki-popover' }, content);
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 8 + window.scrollY;
  pop.style.top = `${top}px`;
  const left = Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - pop.offsetWidth - 12);
  pop.style.left = `${Math.max(8, left)}px`;
  requestAnimationFrame(() => pop.classList.add('show'));

  const close = (): void => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    pop.classList.remove('show');
    setTimeout(() => pop.remove(), 150);
    if (openPopover === pop) {
      openPopover = null;
      closeCurrent = null;
    }
    opts?.onClose?.();
  };
  const onDown = (e: PointerEvent): void => {
    if (opts?.canDismiss && !opts.canDismiss()) return;
    if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (opts?.canDismiss && !opts.canDismiss()) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openPopover = pop;
  closeCurrent = close;
  return close;
}

export function dismissPopover(): void {
  closeCurrent?.();
}
