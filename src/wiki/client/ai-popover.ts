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

export function openAiPopover(ctx: PageContext, block: BlockRef, anchor: HTMLElement): void {
  let running = false;

  const input = h('textarea', {
    class: 'wiki-textarea',
    placeholder: S.ai.placeholder(block.jsx),
    rows: '3',
  });
  const runBtn = h('button', { class: 'wiki-btn wiki-btn-primary' }, icon('sparkle'), ` ${S.ai.run}`);
  const log = h('div', { class: 'wiki-ai-log', style: { display: 'none' } });
  const quick = h(
    'div',
    { class: 'wiki-ai-quick' },
    ...S.ai.quick.map((q) =>
      h(
        'button',
        {
          onclick: () => {
            input.value = q.instruction;
            input.focus();
          },
        },
        q.label,
      ),
    ),
  );

  const body = h(
    'div',
    { class: 'wiki-ai-pop' },
    h('div', { class: 'wiki-panel-title' }, S.ai.title(block.start, block.end)),
    quick,
    input,
    log,
    runBtn,
  );

  const close = popover(anchor, body, { canDismiss: () => !running });

  const run = async (): Promise<void> => {
    const instruction = input.value.trim();
    if (!instruction || running) return;
    running = true;
    input.style.display = 'none';
    quick.style.display = 'none';
    log.style.display = '';
    runBtn.replaceChildren(h('span', { class: 'wiki-working' }, S.ai.working));
    runBtn.setAttribute('disabled', '');

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
          running = false;
          log.append(h('span', { class: 'err' }, event.message));
          runBtn.remove();
          return;
        } else if (event.kind === 'result') {
          running = false;
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
      running = false;
    } catch (err) {
      running = false;
      log.append(h('span', { class: 'err' }, err instanceof Error ? err.message : S.common.requestFailed));
    }
  };
  void close; // popover closes via outside click / Esc once the job isn't running

  runBtn.addEventListener('click', () => void run());
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run();
  });
  input.focus();
}
