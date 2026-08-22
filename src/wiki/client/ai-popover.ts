/**
 * Block-level "ask Claude to edit" popover: anchored to the selected block,
 * with quick-intent chips + a free-form instruction box. While the job runs it
 * shows Claude's live activity (tool lines + streamed commentary); when the
 * edit lands, astro HMR reloads the page (scroll position preserved).
 */
import { stream } from './api';
import type { BlockRef } from './blocks';
import type { PageContext } from './index';
import { rememberScroll } from './index';
import { S } from './strings';
import { h, icon, popover, toast } from './ui';

/** `anchor` positions the popover; `trigger` is the button that owns it */
export function openAiPopover(
  ctx: PageContext,
  block: BlockRef,
  anchor: HTMLElement,
  trigger: HTMLElement,
): void {
  let running = false;

  const input = h('textarea', {
    class: 'wiki-textarea',
    placeholder: S.ai.placeholder(block.jsx),
    'aria-label': S.ai.inputLabel,
    rows: '3',
  });
  const runBtn = h(
    'button',
    { type: 'button', class: 'wiki-btn wiki-btn-primary' },
    icon('sparkle'),
    ` ${S.ai.run}`,
  );
  const log = h('div', { class: 'wiki-ai-log', role: 'log', hidden: true });
  const quick = h(
    'div',
    { class: 'wiki-ai-quick' },
    ...S.ai.quick.map((q) =>
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            input.value = q.instruction;
            input.focus();
          },
        },
        q.label,
      ),
    ),
  );

  const title = S.ai.title(block.start, block.end);
  const body = h(
    'div',
    { class: 'wiki-ai-pop' },
    h('div', { class: 'wiki-panel-title' }, title),
    quick,
    input,
    log,
    runBtn,
  );

  // the popover closes via outside click / focus leaving / Esc once no job is running
  popover(anchor, body, { label: title, trigger, canDismiss: () => !running });

  const run = async (): Promise<void> => {
    const instruction = input.value.trim();
    if (!instruction || running) return;
    running = true;
    input.hidden = true;
    quick.hidden = true;
    log.hidden = false;
    log.setAttribute('aria-busy', 'true');
    runBtn.replaceChildren(h('span', { class: 'wiki-working' }, S.ai.working));
    runBtn.disabled = true;

    let textEl: HTMLElement | null = null;
    const appendTool = (label: string): void => {
      log.append(h('span', { class: 'tool' }, `▸ ${S.common.tool(label)}`));
      textEl = null;
      log.scrollTop = log.scrollHeight;
    };
    const appendText = (text: string): void => {
      if (!textEl) {
        textEl = h('span', { class: 'text' });
        log.append(textEl);
      }
      textEl.textContent += text;
      log.scrollTop = log.scrollHeight;
    };
    const finish = (): void => {
      running = false;
      log.setAttribute('aria-busy', 'false');
    };
    // Recoverable failure (transport error, or the stream ending without a
    // terminal event): show the error and restore the controls for a retry.
    const fail = (message: string): void => {
      finish();
      log.append(h('span', { class: 'err' }, message));
      input.hidden = false;
      quick.hidden = false;
      runBtn.disabled = false;
      runBtn.replaceChildren(icon('sparkle'), ` ${S.ai.run}`);
    };

    try {
      for await (const event of stream('/claude/block', {
        id: ctx.meta.id,
        start: block.start,
        end: block.end,
        instruction,
      })) {
        if (event.kind === 'tool') appendTool(event.label);
        else if (event.kind === 'text') appendText(event.text);
        else if (event.kind === 'error') {
          finish();
          log.append(h('span', { class: 'err' }, event.message));
          runBtn.remove();
          return;
        } else if (event.kind === 'result') {
          finish();
          if (event.ok) {
            rememberScroll();
            toast(S.ai.done);
            setTimeout(() => window.location.reload(), 1600);
          } else {
            log.append(h('span', { class: 'err' }, event.summary || S.ai.jobFailed));
            runBtn.remove();
          }
          return;
        }
      }
      // the stream ended (clean EOF) without an error/result event
      fail(S.ai.streamEnded);
    } catch (err) {
      fail(err instanceof Error ? err.message : S.common.requestFailed);
    }
  };

  runBtn.addEventListener('click', () => void run());
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run();
  });
  input.focus();
}
