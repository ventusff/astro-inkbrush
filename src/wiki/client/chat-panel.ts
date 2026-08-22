/**
 * Page-level Claude panel: a floating action button opens a slide-in glass
 * sidebar for chatting about the current note (claude-cli --resume keeps the
 * conversation), plus a one-click translate action per configured locale
 * whose twin doesn't exist yet.
 *
 * Panel state (messages, session id, open/closed) lives in sessionStorage so
 * it survives the HMR reloads that follow saved edits; a stored value that
 * fails shape validation is discarded.
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

const freshState = (): PanelState => ({ sessionId: null, messages: [], open: false });

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    (m['role'] === 'user' || m['role'] === 'claude') &&
    typeof m['content'] === 'string' &&
    typeof m['html'] === 'boolean'
  );
}

/** parse + validate a stored panel state; anything malformed yields a fresh one */
function readState(raw: string | null): PanelState {
  if (!raw) return freshState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState();
  }
  if (typeof parsed !== 'object' || parsed === null) return freshState();
  const p = parsed as Record<string, unknown>;
  const sessionId = p['sessionId'];
  const messages = p['messages'];
  const open = p['open'];
  if (
    (sessionId !== null && typeof sessionId !== 'string') ||
    !Array.isArray(messages) ||
    !messages.every(isStoredMessage) ||
    typeof open !== 'boolean'
  ) {
    return freshState();
  }
  return { sessionId, messages, open };
}

export function mountChatPanel(ctx: PageContext): void {
  const storeKey = `wiki:chat:${ctx.meta.id}`;
  const state = readState(sessionStorage.getItem(storeKey));
  const persist = (): void => {
    sessionStorage.setItem(
      storeKey,
      JSON.stringify({ ...state, messages: state.messages.slice(-50) }),
    );
  };

  /* ---------- dom ---------- */
  const log = h('div', { class: 'wiki-chat-log', role: 'log' });
  const input = h('textarea', {
    class: 'wiki-textarea',
    placeholder: S.chat.inputPlaceholder,
    'aria-label': S.chat.inputLabel,
    rows: '1',
  });
  const sendBtn = h(
    'button',
    { type: 'button', class: 'wiki-icon-btn', 'aria-label': S.chat.send, title: S.chat.send },
    icon('send'),
  );
  const resetBtn = h(
    'button',
    { type: 'button', class: 'wiki-icon-btn', 'aria-label': S.chat.newChat, title: S.chat.newChat },
    '↺',
  );
  const closeBtn = h(
    'button',
    { type: 'button', class: 'wiki-icon-btn', 'aria-label': S.chat.collapse, title: S.chat.collapse },
    icon('close'),
  );

  // one action per other locale: existing → jump there, missing → translate to it
  const translateButtons: { btn: HTMLButtonElement; code: string; label: string }[] = [];
  const langActions = ctx.meta.locales
    .filter((l) => !l.current)
    .map((l) => {
      if (l.exists) {
        return h(
          'button',
          {
            type: 'button',
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
      const btn = h('button', { type: 'button', class: 'wiki-btn' }, icon('globe'), ` ✦ ${l.label}`);
      translateButtons.push({ btn, code: l.code, label: l.label });
      return btn;
    });

  const panel = h(
    'aside',
    { id: 'wiki-chat-panel', class: 'wiki-chat', role: 'dialog', 'aria-label': S.chat.dialogLabel, inert: true },
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
  const fab = h(
    'button',
    {
      type: 'button',
      class: 'wiki-fab',
      'aria-label': S.chat.fabTitle,
      title: S.chat.fabTitle,
      'aria-haspopup': 'dialog',
      'aria-controls': panel.id,
      'aria-expanded': 'false',
    },
    icon('chat'),
  );
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
        : [h('div', { class: 'wiki-chat-sub wiki-chat-empty' }, S.chat.emptyHint)]),
    );
    log.scrollTop = log.scrollHeight;
  };
  redraw();

  /* ---------- open / close ---------- */
  // Closed = slid out of view + inert (nothing inside is focusable or exposed
  // to assistive technology). Focus enters the input on open; closing moves
  // focus to the FAB when it is inside the panel.
  const setOpen = (open: boolean, focus = true): void => {
    const hadFocus = panel.contains(document.activeElement);
    state.open = open;
    panel.classList.toggle('open', open);
    panel.inert = !open;
    fab.hidden = open;
    fab.setAttribute('aria-expanded', String(open));
    if (open) {
      if (focus) input.focus();
    } else if (hadFocus) {
      fab.focus();
    }
    persist();
  };
  fab.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  });
  if (state.open) setOpen(true, false);

  /* ---------- busy / generation ---------- */
  // A generation identifies one conversation. Each stream captures the
  // generation current at its start and stops touching shared state once the
  // panel's generation moves past it. Reset stays available during a run: it
  // advances the generation, aborts the in-flight request and clears the
  // conversation.
  let busy = false;
  let generation = 0;
  let inflight: AbortController | null = null;
  const setBusy = (value: boolean): void => {
    busy = value;
    sendBtn.disabled = value;
    log.setAttribute('aria-busy', String(value));
  };
  resetBtn.addEventListener('click', () => {
    generation += 1;
    inflight?.abort();
    inflight = null;
    state.sessionId = null;
    state.messages = [];
    persist();
    redraw();
    toast(S.chat.newChatStarted);
  });

  /* ---------- streaming into the log ---------- */
  async function runStream(
    path: string,
    payload: Record<string, unknown>,
    opts: { captureSession: boolean },
  ): Promise<void> {
    const mine = generation;
    const request = new AbortController();
    inflight = request;
    setBusy(true);
    const live = h('div', { class: 'wiki-msg claude' });
    const spinner = h('span', { class: 'wiki-working' }, S.chat.thinking);
    live.append(spinner);
    log.append(live);
    log.scrollTop = log.scrollHeight;

    let text = '';
    let textEl: HTMLElement | null = null;
    try {
      for await (const event of stream(path, payload, request.signal)) {
        if (mine !== generation) return;
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
            textEl = h('div', { class: 'text' });
            live.append(textEl);
          }
          text += event.text;
          textEl.textContent += event.text;
          log.scrollTop = log.scrollHeight;
        } else if (event.kind === 'error') {
          spinner.remove();
          live.append(h('div', { class: 'tool err' }, event.message));
          state.messages.push({ role: 'claude', content: event.message, html: false });
          persist();
          return;
        } else if (event.kind === 'result') {
          spinner.remove();
          const summary = text.trim() || event.summary;
          // final pass: render the answer as sanitized markdown (math incl.)
          let html = '';
          try {
            ({ html } = await api.post<{ html: string }>(
              '/render',
              { markdown: summary, sanitize: true },
              { signal: request.signal },
            ));
          } catch {
            /* keep plain text */
          }
          if (mine !== generation) return;
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
      // the stream ended (clean EOF) without an error/result event
      if (mine === generation) {
        spinner.remove();
        live.append(h('div', { class: 'tool err' }, S.chat.streamEnded));
      }
    } catch (err) {
      if (mine !== generation) return;
      spinner.remove();
      live.append(h('div', { class: 'tool err' }, err instanceof Error ? err.message : S.common.requestFailed));
    } finally {
      if (inflight === request) inflight = null;
      setBusy(false);
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
      const mine = generation;
      setOpen(true);
      translateButtons.forEach((t) => {
        t.btn.disabled = true;
      });
      state.messages.push({ role: 'user', content: S.chat.translateAction(label), html: false });
      persist();
      log.append(bubble(state.messages.at(-1)!));
      await runStream('/claude/translate', { id: ctx.meta.id, targetLang: code }, { captureSession: false });
      translateButtons.forEach((t) => {
        t.btn.disabled = false;
      });
      if (mine !== generation) return;
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
