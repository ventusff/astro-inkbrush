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
import { h, time, toast } from './ui';

/** Initial avatar. Decorative: the author's name is rendered right next to
 *  it, so the avatar is hidden from assistive technology. */
function avatarOf(author: WikiComment['author']): HTMLElement {
  return h(
    'span',
    { class: 'wiki-avatar wiki-avatar-fallback', 'aria-hidden': 'true' },
    [...author.name][0]?.toUpperCase() ?? '?',
  );
}

export function mountComments(ctx: PageContext): void {
  /**
   * Mount contract: an explicit `[data-inkbrush-slot="comments"]` container
   * wins; the `.note-main .col` class fallback exists for slotless sites.
   * Neither present → comments stay off.
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
    { class: 'wiki-comments', 'aria-label': S.comments.sectionTitle },
    h('div', { class: 'wiki-comments-title' }, S.comments.sectionTitle, countEl),
    list,
  );

  const commentNode = (comment: WikiComment): HTMLElement => {
    const body = h('div', { class: 'wiki-comment-body' });
    body.innerHTML = comment.html;
    // delete permission is computed per requester by the server
    const mine = comment.canDelete;
    const node = h(
      'div',
      { class: 'wiki-comment' },
      avatarOf(comment.author),
      h(
        'div',
        { class: 'wiki-comment-main' },
        h(
          'div',
          { class: 'wiki-comment-meta' },
          h('span', { class: 'name' }, comment.author.name),
          time(comment.ts),
          mine
            ? h(
                'button',
                {
                  type: 'button',
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
              type: 'button',
              onclick: () => {
                // the account chip specifically — `.wiki-chip` alone can hit
                // the share chip first
                document.querySelector<HTMLButtonElement>('.wiki-chip[data-wiki-role="account"]')?.click();
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
      'aria-label': S.comments.inputLabel,
      rows: '3',
    });
    const preview = h('div', { class: 'wiki-comment-body wiki-comment-preview', hidden: true });
    const previewBtn = h(
      'button',
      { type: 'button', class: 'wiki-btn wiki-comment-previewbtn', 'aria-pressed': 'false' },
      S.comments.preview,
    );
    const submitBtn = h('button', { type: 'button', class: 'wiki-btn wiki-btn-primary' }, S.comments.post);
    let previewing = false;
    // every toggle advances the generation, so a slow render response can
    // never overwrite the preview of a newer toggle (or the edit view)
    let previewGeneration = 0;
    const note = (text: string): HTMLElement => h('em', { class: 'wiki-comment-note' }, text);

    previewBtn.addEventListener('click', async () => {
      previewing = !previewing;
      previewGeneration += 1;
      const generation = previewGeneration;
      previewBtn.textContent = previewing ? S.comments.keepEditing : S.comments.preview;
      previewBtn.setAttribute('aria-pressed', String(previewing));
      input.hidden = previewing;
      preview.hidden = !previewing;
      if (previewing) {
        preview.replaceChildren(note(S.comments.rendering));
        try {
          const { html } = await api.post<{ html: string }>('/render', {
            markdown: input.value,
            sanitize: true,
          });
          if (generation !== previewGeneration) return;
          if (html) preview.innerHTML = html;
          else preview.replaceChildren(note(S.editor.empty));
        } catch {
          if (generation !== previewGeneration) return;
          preview.textContent = S.comments.previewFailed;
        }
      }
    });

    submitBtn.addEventListener('click', async () => {
      const markdown = input.value.trim();
      if (!markdown) return;
      submitBtn.disabled = true;
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
        submitBtn.disabled = false;
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
    // canDelete is computed per requester: refetch under the new identity
    void (async () => {
      try {
        ({ comments } = await api.get<{ comments: WikiComment[] }>(`/comments/${meta.id}`));
        redrawList();
      } catch {
        /* keep the current list */
      }
    })();
  });

  section.append(composerHost);
  column.append(section);
}
