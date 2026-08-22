/**
 * Comment section, appended to the bottom of the reading column on every
 * note page. Markdown input (GFM + $…$ math) with a live preview tab;
 * rendering happens server-side through the sanitizing pipeline.
 */
import type { NoteMeta, WikiComment } from '../shared/types';
import { api } from './api';
import { currentUser, onAuthChange } from './auth';
import type { PageContext } from './index';
import { S } from './strings';
import { h, toast } from './ui';

function avatarOf(author: WikiComment['author']): HTMLElement {
  if (author.picture) {
    return h('img', { class: 'wiki-avatar', src: author.picture, alt: author.name, referrerpolicy: 'no-referrer' });
  }
  return h('span', { class: 'wiki-avatar wiki-avatar-fallback' }, [...author.name][0]?.toUpperCase() ?? '?');
}

function timeLabel(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function mountComments(ctx: PageContext): void {
  /**
   * Mount contract: the site marks the comment container with
   * `[data-inkbrush-slot="comments"]`; a `.note-main .col` reading column is
   * honored as a fallback convention. Neither present → comments stay off.
   */
  const column =
    document.querySelector('[data-inkbrush-slot="comments"]') ??
    document.querySelector('.note-main .col');
  if (!column) {
    console.warn(
      '[wiki] comments: no mount point — add [data-inkbrush-slot="comments"] to the container (a .note-main .col column also works)',
    );
    return;
  }
  void render(ctx.meta, column);
}

async function render(meta: NoteMeta, column: Element): Promise<void> {
  let comments: WikiComment[] = [];
  try {
    ({ comments } = await api.get<{ comments: WikiComment[] }>(`/comments/${meta.id}`));
  } catch {
    return;
  }

  const list = h('div', {});
  const countEl = h('span', { class: 'count' });
  const section = h(
    'section',
    { class: 'wiki-comments' },
    h('div', { class: 'wiki-comments-title' }, S.comments.sectionTitle, countEl),
    list,
  );

  const commentNode = (comment: WikiComment): HTMLElement => {
    const body = h('div', { class: 'wiki-comment-body' });
    body.innerHTML = comment.html;
    const mine = currentUser()?.email === comment.author.email;
    const node = h(
      'div',
      { class: 'wiki-comment' },
      avatarOf(comment.author),
      h(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        h(
          'div',
          { class: 'wiki-comment-meta' },
          h('span', { class: 'name' }, comment.author.name),
          h('span', {}, timeLabel(comment.ts)),
          mine
            ? h(
                'button',
                {
                  class: 'wiki-comment-del',
                  onclick: async () => {
                    if (!window.confirm(S.comments.confirmDelete)) return;
                    try {
                      await api.delete(`/comments/${meta.id}?cid=${comment.id}`);
                      node.remove();
                      comments = comments.filter((c) => c.id !== comment.id);
                      redrawCount();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : S.comments.deleteFailed, 'err');
                    }
                  },
                },
                S.comments.delete,
              )
            : null,
        ),
        body,
      ),
    );
    return node;
  };

  const redrawCount = (): void => {
    countEl.textContent = S.comments.count(comments.length);
  };
  const redrawList = (): void => {
    list.replaceChildren(...comments.map(commentNode));
    redrawCount();
  };
  redrawList();

  /* ---- composer ---- */
  const composerHost = h('div', {});
  const drawComposer = (): void => {
    const user = currentUser();
    if (!user) {
      composerHost.replaceChildren(
        h(
          'div',
          { class: 'wiki-comment-signin' },
          S.comments.signInPrompt,
          h(
            'button',
            {
              onclick: () => {
                document.querySelector<HTMLButtonElement>('.wiki-chip')?.click();
              },
            },
            S.comments.signIn,
          ),
        ),
      );
      return;
    }
    const input = h('textarea', {
      class: 'wiki-textarea',
      placeholder: S.comments.placeholder,
      rows: '3',
    });
    const preview = h('div', { class: 'wiki-comment-body', style: { display: 'none', padding: '8px 2px' } });
    const previewBtn = h(
      'button',
      { class: 'wiki-btn', style: { width: 'auto', padding: '6px 12px' } },
      S.comments.preview,
    );
    const submitBtn = h('button', { class: 'wiki-btn wiki-btn-primary' }, S.comments.post);
    let previewing = false;

    previewBtn.addEventListener('click', async () => {
      previewing = !previewing;
      previewBtn.textContent = previewing ? S.comments.keepEditing : S.comments.preview;
      input.style.display = previewing ? 'none' : '';
      preview.style.display = previewing ? '' : 'none';
      if (previewing) {
        preview.innerHTML = `<em style="color:var(--wiki-faint)">${S.comments.rendering}</em>`;
        try {
          const { html } = await api.post<{ html: string }>('/render', {
            markdown: input.value,
            sanitize: true,
          });
          preview.innerHTML = html || `<em style="color:var(--wiki-faint)">${S.editor.empty}</em>`;
        } catch {
          preview.textContent = S.comments.previewFailed;
        }
      }
    });

    submitBtn.addEventListener('click', async () => {
      const markdown = input.value.trim();
      if (!markdown) return;
      submitBtn.setAttribute('disabled', '');
      try {
        const { comment } = await api.post<{ comment: WikiComment }>(`/comments/${meta.id}`, { markdown });
        comments.push(comment);
        redrawList();
        input.value = '';
        if (previewing) previewBtn.click();
        toast(S.comments.posted);
      } catch (err) {
        toast(err instanceof Error ? err.message : S.comments.postFailed, 'err');
      } finally {
        submitBtn.removeAttribute('disabled');
      }
    });

    composerHost.replaceChildren(
      h(
        'div',
        { class: 'wiki-comment-form' },
        input,
        preview,
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'hint' }, S.comments.postingAs(user.name)),
          previewBtn,
          submitBtn,
        ),
      ),
    );
  };
  drawComposer();
  onAuthChange(() => {
    drawComposer();
    redrawList(); // delete buttons depend on identity
  });

  section.append(composerHost);
  column.append(section);
}
