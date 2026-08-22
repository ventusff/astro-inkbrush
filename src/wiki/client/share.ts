/**
 * Share button + popover — mounted only on note pages, only into the site's
 * `[data-inkbrush-slot="share"]` slot, and only when the deployment enables
 * the share module (/me → share: 'ready' | 'unconfigured'; 'off' ⇒ not
 * mounted at all).
 *
 * States: no active share → create form (generated editable password +
 * expiry) → busy (NDJSON progress from the minutes-long first build) →
 * result (URL + password, shown ONCE — the server only stores the scrypt
 * hash); active share → URL + expiry + revoke.
 */
import type { ShareCreateRequest, ShareListResponse, ShareRecord, ShareStreamEvent } from '../shared/types';
import { api, ApiError, stream } from './api';
import { currentUser, onAuthChange, shareAvailability } from './auth';
import type { PageContext } from './index';
import { formatDate, S } from './strings';
import { h, icon, popover, toast, uid } from './ui';

/* ---------------- helpers ---------------- */

/** 10-char a-z0-9 passphrase (rejection sampling, unbiased) */
function genPassword(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252 /* 36*7 */ && out.length < length) out += alphabet[byte % 36]!;
    }
  }
  return out;
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(S.share.copied(label));
  } catch {
    toast(S.share.copyFailed, 'err');
  }
}

function copyRow(label: string, value: string): HTMLElement {
  const id = uid('share');
  const input = h('input', { id, class: 'wiki-input wiki-share-mono', value, readonly: true });
  input.addEventListener('focus', () => input.select());
  return h(
    'div',
    { class: 'wiki-share-row' },
    h('label', { class: 'wiki-form-label', for: id }, label),
    h(
      'div',
      { class: 'wiki-share-copy' },
      input,
      h(
        'button',
        { type: 'button', class: 'wiki-btn wiki-share-copybtn', onclick: () => void copyText(value, label) },
        S.share.copy,
      ),
    ),
  );
}

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return S.share.neverExpires;
  return S.share.expiresOn(formatDate(expiresAt, 'date'));
}

/* ---------------- popover panels ---------------- */

interface PanelCtx {
  noteId: string;
  render: (el: HTMLElement) => void;
  setBusy: (value: boolean) => void;
}

function activeView(ctx: PanelCtx, record: ShareRecord, password?: string): HTMLElement {
  const revokeBtn = h(
    'button',
    {
      type: 'button',
      class: 'wiki-btn wiki-share-revoke',
      onclick: async () => {
        revokeBtn.disabled = true;
        try {
          await api.delete(`/share/${record.id}`);
          toast(S.share.revoked);
          ctx.render(createForm(ctx));
        } catch (err) {
          revokeBtn.disabled = false;
          toast(err instanceof Error ? err.message : S.share.revokeFailed, 'err');
        }
      },
    },
    S.share.revoke,
  );
  return h(
    'div',
    { class: 'wiki-share-panel' },
    copyRow(S.share.link, record.url),
    password !== undefined
      ? copyRow(S.share.password, password)
      : h('div', { class: 'wiki-share-hint' }, S.share.passwordOnce),
    password !== undefined
      ? h('div', { class: 'wiki-share-hint' }, S.share.savePasswordNow)
      : null,
    h('div', { class: 'wiki-share-meta' }, expiryLabel(record.expiresAt)),
    revokeBtn,
  );
}

function createForm(ctx: PanelCtx): HTMLElement {
  const passwordId = uid('share-password');
  const expiryId = uid('share-expiry');
  const password = h('input', {
    id: passwordId,
    class: 'wiki-input wiki-share-mono',
    value: genPassword(),
    autocomplete: 'off',
    spellcheck: false,
  });
  const expiry = h(
    'select',
    { id: expiryId, class: 'wiki-input wiki-share-expiry' },
    h('option', { value: '7', selected: true }, S.share.days7),
    h('option', { value: '30' }, S.share.days30),
    h('option', { value: '' }, S.share.never),
  );
  const status = h('div', { class: 'wiki-share-status', role: 'status', 'aria-live': 'polite' });
  const submit = h('button', { class: 'wiki-btn wiki-btn-primary', type: 'submit' }, S.share.create);

  const create = async (): Promise<void> => {
    const pass = password.value.trim();
    if (pass.length < 6) {
      toast(S.share.passwordMin, 'err');
      return;
    }
    ctx.setBusy(true);
    submit.disabled = true;
    password.disabled = true;
    expiry.disabled = true;
    status.textContent = S.share.building;
    try {
      let result: ShareRecord | null = null;
      const body: ShareCreateRequest = {
        note: ctx.noteId,
        password: pass,
        expiresDays: expiry.value ? (Number(expiry.value) as 7 | 30) : null,
      };
      for await (const event of stream<ShareStreamEvent>('/share', body)) {
        if (event.kind === 'progress') status.textContent = event.message;
        else if (event.kind === 'result') result = event.share;
        else if (event.kind === 'error') throw new Error(event.message);
      }
      if (!result) throw new Error(S.share.streamEnded);
      ctx.setBusy(false);
      ctx.render(activeView(ctx, result, pass));
      toast(S.share.created);
    } catch (err) {
      ctx.setBusy(false);
      submit.disabled = false;
      password.disabled = false;
      expiry.disabled = false;
      status.textContent = '';
      const message =
        err instanceof ApiError && err.status === 502
          ? S.share.gatewayUnreachable(err.message)
          : err instanceof Error
            ? err.message
            : S.share.shareFailed;
      toast(message, 'err');
    }
  };

  return h(
    'form',
    {
      class: 'wiki-share-panel',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void create();
      },
    },
    h('div', { class: 'wiki-share-hint' }, S.share.intro),
    h('div', { class: 'wiki-share-row' }, h('label', { class: 'wiki-form-label', for: passwordId }, S.share.password), password),
    h('div', { class: 'wiki-share-row' }, h('label', { class: 'wiki-form-label', for: expiryId }, S.share.expires), expiry),
    submit,
    status,
  );
}

async function openSharePopover(anchor: HTMLElement, noteId: string): Promise<void> {
  let busy = false;
  const content = h('div', { class: 'wiki-share-body' }, h('div', { class: 'wiki-share-hint' }, S.share.loading));
  const panel = h('div', {}, h('div', { class: 'wiki-panel-title' }, S.share.title), content);
  popover(anchor, panel, { label: S.share.title, canDismiss: () => !busy });
  const ctx: PanelCtx = {
    noteId,
    render: (el) => content.replaceChildren(el),
    setBusy: (value) => {
      busy = value;
    },
  };
  try {
    const { shares } = await api.get<ShareListResponse>(`/share?note=${encodeURIComponent(noteId)}`);
    const active = shares[0];
    ctx.render(active ? activeView(ctx, active) : createForm(ctx));
  } catch (err) {
    ctx.render(
      h(
        'div',
        { class: 'wiki-share-hint wiki-share-error' },
        err instanceof Error ? err.message : S.share.loadFailed,
      ),
    );
  }
}

/* ---------------- mount ---------------- */

/** Note pages only (index.ts calls this after meta resolves). Mounts nothing
 *  when the site declares no slot or the share module is off. */
export function mountShare(pageCtx: PageContext): void {
  const slot = document.querySelector('[data-inkbrush-slot="share"]');
  if (!slot) return;
  const state = shareAvailability();
  if (state === 'off') return;
  const noteId = pageCtx.meta.id;

  const btn = h(
    'button',
    {
      type: 'button',
      class: 'wiki-chip wiki-share-chip',
      'aria-label': S.share.title,
      'aria-expanded': 'false',
      disabled: state !== 'ready',
      title: state === 'ready' ? S.share.chipReady : S.share.chipUnconfigured,
    },
    icon('share'),
    h('span', { class: 'wiki-chip-name' }, S.share.chip),
  );
  btn.addEventListener('click', () => {
    if (state === 'ready') void openSharePopover(btn, noteId);
  });

  const holder = h('span', { class: 'wiki-share-slot' }, btn);
  // signed-in users only — follow login/logout live
  const sync = (): void => {
    holder.hidden = !currentUser();
  };
  sync();
  onAuthChange(sync);
  slot.append(holder);
}
