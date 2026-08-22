/** tiny DOM builder + shared popover / toast / time primitives for the wiki chrome */
import { type DateStyle, formatDate } from './strings';

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

/** unique element id for label ↔ control binding */
let idSeq = 0;
export function uid(prefix: string): string {
  idSeq += 1;
  return `wiki-${prefix}-${idSeq}`;
}

/** `<time datetime>` rendered through the shared locale-aware formatter */
export function time(value: number | string | Date, style: DateStyle = 'datetime'): HTMLTimeElement {
  const date = new Date(value);
  return h('time', { datetime: date.toISOString() }, formatDate(date, style));
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

/* ---------------- toasts ---------------- */

/**
 * Two persistent live regions (status: polite, alert: assertive) mounted once
 * at the bottom center; every toast is appended into one of them so assistive
 * technology announces it as a live-region addition.
 */
let toastRegions: { status: HTMLElement; alert: HTMLElement } | null = null;

function regionFor(kind: 'ok' | 'err'): HTMLElement {
  if (!toastRegions) {
    const status = h('div', { class: 'wiki-toast-region', role: 'status', 'aria-live': 'polite' });
    const alert = h('div', { class: 'wiki-toast-region', role: 'alert' });
    document.body.append(h('div', { class: 'wiki-toasts' }, status, alert));
    toastRegions = { status, alert };
  }
  return kind === 'err' ? toastRegions.alert : toastRegions.status;
}

/** ephemeral toast, bottom center */
export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = h('div', { class: `wiki-toast ${kind}` }, message);
  regionFor(kind).append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 5200 : 2600);
}

/* ---------------- popover ---------------- */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function firstFocusable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(FOCUSABLE);
}

export interface PopoverOptions {
  /** accessible name of the dialog */
  label: string;
  /** the control that owns the popover (aria-expanded + focus restore); defaults to `anchor` */
  trigger?: HTMLElement;
  onClose?: () => void;
  canDismiss?: () => boolean;
}

/**
 * One-at-a-time floating non-modal dialog, light-dismissed on outside
 * pointerdown, on focus leaving it, and on Escape. `anchor` positions it
 * (below-start alignment, clamped to the viewport). Focus moves to the first
 * focusable child on open (the dialog itself when there is none) and returns
 * to the trigger on close when it is still inside. While open, the trigger
 * carries aria-expanded="true" and aria-controls pointing at the dialog's id.
 */
let openPopover: HTMLElement | null = null;
let closeCurrent: (() => void) | null = null;

export function popover(anchor: HTMLElement, content: HTMLElement, opts: PopoverOptions): () => void {
  dismissPopover();
  const trigger = opts.trigger ?? anchor;
  const pop = h(
    'div',
    { id: uid('popover'), class: 'wiki-popover', role: 'dialog', 'aria-label': opts.label, tabindex: '-1' },
    content,
  );
  trigger.setAttribute('aria-controls', pop.id);
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 8 + window.scrollY;
  pop.style.top = `${top}px`;
  const left = Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - pop.offsetWidth - 12);
  pop.style.left = `${Math.max(8, left)}px`;
  requestAnimationFrame(() => pop.classList.add('show'));
  trigger.setAttribute('aria-expanded', 'true');
  (firstFocusable(pop) ?? pop).focus();

  const mayDismiss = (): boolean => !opts.canDismiss || opts.canDismiss();
  const isInside = (node: EventTarget | null): boolean =>
    node instanceof Node && (pop.contains(node) || node === anchor || anchor.contains(node));

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (pop.contains(document.activeElement)) trigger.focus();
    pop.classList.remove('show');
    setTimeout(() => pop.remove(), 150);
    if (openPopover === pop) {
      openPopover = null;
      closeCurrent = null;
    }
    opts.onClose?.();
  };
  const onDown = (e: PointerEvent): void => {
    if (mayDismiss() && !isInside(e.target)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !mayDismiss()) return;
    e.preventDefault();
    close();
  };
  pop.addEventListener('focusout', (e) => {
    // relatedTarget is null when the window itself loses focus: stay open
    if (e.relatedTarget instanceof Node && mayDismiss() && !isInside(e.relatedTarget)) close();
  });
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openPopover = pop;
  closeCurrent = close;
  return close;
}

export function dismissPopover(): void {
  closeCurrent?.();
}
