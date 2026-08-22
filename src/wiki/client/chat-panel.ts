/**
 * Page-level Claude panel: a floating action button opens a slide-in glass
 * sidebar for chatting about the current note (claude-cli --resume keeps the
 * conversation), plus a one-click translate action per configured locale
 * whose twin doesn't exist yet.
 *
 * Panel state (messages, session id, open/closed) lives in sessionStorage so
 * it survives the HMR reloads that follow saved edits.
 */
import { api, stream } from './api';
import { currentUser } from './auth';
import type { PageContext } from './index';
import { rememberScroll } from './index';
import { S } from './strings';
import { h, icon, toast } from './ui';

interface StoredMessage {
  role: 'user' | 'claude';
  /** rendered html for claude messages, plain text for user messages */
  content: string;
  html: boolean;
}

interface PanelState {
  sessionId: string | null;
  messages: StoredMessage[];
  open: boolean;
}

export function mountChatPanel(ctx: PageContext): void {
  const storeKey = `wiki:chat:${ctx.meta.id}`;
  const state: PanelState = JSON.parse(
    sessionStorage.getItem(storeKey) ?? 'null',
  ) as PanelState | null ?? { sessionId: null, messages: [], open: false };
  const persist = (): void => {
    sessionStorage.setItem(
      storeKey,
      JSON.stringify({ ...state, messages: state.messages.slice(-50) }),
    );
  };

  let busy = false;

  /* ---------- dom ---------- */
  const log = h('div', { class: 'wiki-chat-log' });
  const input = h('textarea', {
    class: 'wiki-textarea',
    placeholder: S.chat.inputPlaceholder,
    rows: '1',
  });
  const sendBtn = h('button', { class: 'wiki-icon-btn', title: S.chat.send }, icon('send'));
  const resetBtn = h('button', { class: 'wiki-icon-btn', title: S.chat.newChat }, '↺');
  const closeBtn = h('button', { class: 'wiki-icon-btn', title: S.chat.collapse }, icon('close'));

  // one action per other locale: existing → jump there, missing → translate to it
  const translateButtons: { btn: HTMLButtonElement; code: string; label: string }[] = [];
  const langActions = ctx.meta.locales
    .filter((l) => !l.current)
    .map((l) => {
      if (l.exists) {
        return h(
          'button',
          {
            class: 'wiki-btn',
            onclick: () => {
              // sites customize the jump template via <meta name="inkbrush-note-url" content="/{id}/">
              const pattern =
                document.querySelector('meta[name="inkbrush-note-url"]')?.getAttribute('content') ?? '/{id}/';
              window.location.href = pattern.replace('{id}', l.id);
            },
          },
          icon('globe'),
          ` ${l.label} →`,
        );
      }
      const btn = h('button', { class: 'wiki-btn' }, icon('globe'), ` ✦ ${l.label}`);
      translateButtons.push({ btn, code: l.code, label: l.label });
      return btn;
    });

  const panel = h(
    'aside',
    { class: 'wiki-chat', role: 'dialog', 'aria-label': S.chat.dialogLabel },
    h(
      'div',
      { class: 'wiki-chat-head' },
      h(
        'div',
        {},
        h('div', { class: 'wiki-chat-title' }, S.chat.title),
        h('div', { class: 'wiki-chat-sub' }, ctx.meta.title),
      ),
      h('span', { class: 'spacer' }),
      resetBtn,
      closeBtn,
    ),
    h('div', { class: 'wiki-chat-actions' }, ...langActions),
    log,
    h('div', { class: 'wiki-chat-input' }, input, sendBtn),
  );
  const fab = h('button', { class: 'wiki-fab', title: S.chat.fabTitle }, icon('chat'));
  document.body.append(fab, panel);

  /* ---------- message rendering ---------- */
  const bubble = (msg: StoredMessage): HTMLElement => {
    const el = h('div', { class: `wiki-msg ${msg.role}` });
    if (msg.html) el.innerHTML = msg.content;
    else el.textContent = msg.content;
    return el;
  };
  const redraw = (): void => {
    log.replaceChildren(
      ...(state.messages.length
        ? state.messages.map(bubble)
        : [
            h(
              'div',
              { class: 'wiki-chat-sub', style: { textAlign: 'center', marginTop: '2em' } },
              S.chat.emptyHint,
            ),
          ]),
    );
    log.scrollTop = log.scrollHeight;
  };
  redraw();

  const setOpen = (open: boolean): void => {
    state.open = open;
    panel.classList.toggle('open', open);
    fab.style.display = open ? 'none' : '';
    if (open) input.focus();
    persist();
  };
  fab.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  resetBtn.addEventListener('click', () => {
    state.sessionId = null;
    state.messages = [];
    persist();
    redraw();
    toast(S.chat.newChatStarted);
  });
  if (state.open) setOpen(true);

  /* ---------- streaming into the log ---------- */
  async function runStream(
    path: string,
    payload: Record<string, unknown>,
    opts: { captureSession: boolean },
  ): Promise<void> {
    busy = true;
    sendBtn.setAttribute('disabled', '');
    const live = h('div', { class: 'wiki-msg claude' });
    const spinner = h('span', { class: 'wiki-working' }, S.chat.thinking);
    live.append(spinner);
    log.append(live);
    log.scrollTop = log.scrollHeight;

    let text = '';
    let textEl: HTMLElement | null = null;
    try {
      for await (const event of stream(path, payload)) {
        if (event.kind === 'init' && opts.captureSession) {
          state.sessionId = event.sessionId;
          persist();
        } else if (event.kind === 'tool') {
          spinner.remove();
          live.append(h('span', { class: 'tool' }, `▸ ${S.common.tool(event.label)}`));
          textEl = null;
          log.scrollTop = log.scrollHeight;
        } else if (event.kind === 'text') {
          spinner.remove();
          if (!textEl) {
            textEl = h('div', { style: { whiteSpace: 'pre-wrap' } });
            live.append(textEl);
          }
          text += event.text;
          textEl.textContent += event.text;
          log.scrollTop = log.scrollHeight;
        } else if (event.kind === 'error') {
          spinner.remove();
          live.append(h('div', { class: 'tool', style: { color: '#8c2f1b' } }, event.message));
          state.messages.push({ role: 'claude', content: event.message, html: false });
          persist();
          return;
        } else if (event.kind === 'result') {
          spinner.remove();
          const summary = text.trim() || event.summary;
          // final pass: render the answer as sanitized markdown (math incl.)
          let html = '';
          try {
            ({ html } = await api.post<{ html: string }>('/render', {
              markdown: summary,
              sanitize: true,
            }));
          } catch {
            /* keep plain text */
          }
          const stored: StoredMessage = html
            ? { role: 'claude', content: html, html: true }
            : { role: 'claude', content: summary, html: false };
          state.messages.push(stored);
          persist();
          live.replaceWith(bubble(stored));
          log.scrollTop = log.scrollHeight;
          return;
        }
      }
    } catch (err) {
      spinner.remove();
      live.append(
        h(
          'div',
          { class: 'tool', style: { color: '#8c2f1b' } },
          err instanceof Error ? err.message : S.common.requestFailed,
        ),
      );
    } finally {
      busy = false;
      sendBtn.removeAttribute('disabled');
    }
  }

  /* ---------- ask ---------- */
  const send = async (): Promise<void> => {
    const message = input.value.trim();
    if (!message || busy) return;
    if (!currentUser()) {
      toast(S.chat.signInFirst, 'err');
      return;
    }
    input.value = '';
    state.messages.push({ role: 'user', content: message, html: false });
    persist();
    log.append(bubble(state.messages.at(-1)!));
    await runStream(
      '/claude/ask',
      { id: ctx.meta.id, message, ...(state.sessionId ? { sessionId: state.sessionId } : {}) },
      { captureSession: true },
    );
  };
  sendBtn.addEventListener('click', () => void send());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  /* ---------- translate (one handler per missing locale) ---------- */
  for (const { btn, code, label } of translateButtons) {
    btn.addEventListener('click', async () => {
      if (busy) return;
      if (!currentUser()) {
        toast(S.chat.signInFirst, 'err');
        return;
      }
      if (!window.confirm(S.chat.translateConfirm(label))) {
        return;
      }
      setOpen(true);
      translateButtons.forEach((t) => t.btn.setAttribute('disabled', ''));
      state.messages.push({ role: 'user', content: S.chat.translateAction(label), html: false });
      persist();
      log.append(bubble(state.messages.at(-1)!));
      await runStream('/claude/translate', { id: ctx.meta.id, targetLang: code }, { captureSession: false });
      translateButtons.forEach((t) => t.btn.removeAttribute('disabled'));
      // if the target now exists, reload so the language switch shows it
      try {
        const meta = await api.get<typeof ctx.meta>(`/meta/${ctx.meta.id}`);
        if (meta.locales.find((l) => l.code === code)?.exists) {
          rememberScroll();
          toast(S.chat.translateDone);
          setTimeout(() => window.location.reload(), 1600);
        }
      } catch {
        /* ignore */
      }
    });
  }
}
