/**
 * Members dialog (identity module, admin only) — lazy-loaded from the
 * account popover. One row per member: their initial, their name (edited in
 * place: Enter or leaving the field saves, Escape puts it back), their handle
 * and email, the other addresses their commits carry (chips; adding one makes
 * those commits theirs), their role and a two-step remove. A search field
 * narrows the rows by name, handle or address; the add form sits at the foot.
 *
 * The registry is one file, so every change PUTs the whole list, naming the
 * version it was made against. Changes queue: each one is applied to the
 * list the previous save returned, one PUT at a time, so a second edit made
 * while a save is in flight is neither lost nor blocked; when another admin
 * saved meanwhile (409), the change is applied once more to their list. After each save the rows re-render from the server's
 * list; the focused field keeps its focus and whatever is typed in it, and a
 * refused name or address goes back into its field. The server enforces the
 * role vocabulary, the name rules, one owner per address and the
 * at-least-one-admin rule; its refusals surface as toasts. The signed-in
 * admin's own row cannot be removed here — the dialog never locks its user
 * out.
 */
import { peopleOf } from '../../lib/people.ts';
import type { IdentityUser, IdentityUsersResponse } from '../shared/types';
import { api, ApiError } from './api';
import { PEOPLE_CHANGED } from './people-events';
import { errorText, S } from './strings';
import { h, icon, toast } from './ui';

/** the focused control of the list, so a re-render can give it back */
interface Focus {
  row: string;
  cls: string;
  /** what was typed in it, for an input */
  value: string | null;
  start: number | null;
  end: number | null;
}

export async function openMembersDialog(self: string): Promise<void> {
  let data: IdentityUsersResponse;
  try {
    data = await api.get<IdentityUsersResponse>('/identity/users');
  } catch (err) {
    toast(errorText(err, S.identity.loadFailed), 'err');
    return;
  }

  /** the list as the server last returned it, and its version */
  let users = data.users;
  let revision = data.revision;
  let query = '';
  /** the row whose remove button is waiting for its second click */
  let confirming: string | null = null;
  const me = self.toLowerCase();

  const list = h('ul', { class: 'wiki-members-list', role: 'list' });
  const count = h('span', { class: 'wiki-members-count' });
  const dialog = h('dialog', { class: 'wiki-members', 'aria-labelledby': 'wiki-members-title' });

  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;

  /** queue a change: `change` turns the latest saved list into the next one; resolves true once saved */
  const save = (change: (current: IdentityUser[]) => IdentityUser[], done: string): Promise<boolean> => {
    pending += 1;
    dialog.setAttribute('aria-busy', 'true');
    const put = async (): Promise<void> => {
      const res = await api.put<{ users: IdentityUser[]; revision: string }>('/identity/users', { users: change(users), revision });
      users = res.users;
      revision = res.revision;
    };
    const run = queue.then(async () => {
      try {
        try {
          await put();
        } catch (err) {
          // another admin saved meanwhile: apply the change to their list instead
          if (!(err instanceof ApiError) || err.status !== 409) throw err;
          const fresh = await api.get<IdentityUsersResponse>('/identity/users');
          users = fresh.users;
          revision = fresh.revision;
          await put();
        }
        toast(done);
        // open editors re-read the members their @ completes from
        window.dispatchEvent(new Event(PEOPLE_CHANGED));
        return true;
      } catch (err) {
        toast(errorText(err, S.identity.saveFailed), 'err');
        return false;
      } finally {
        pending -= 1;
        if (pending === 0) dialog.setAttribute('aria-busy', 'false');
        render();
      }
    });
    queue = run;
    return run;
  };

  const withMember = (email: string, change: (u: IdentityUser) => IdentityUser) => (current: IdentityUser[]) =>
    current.map((u) => (u.email === email ? change(u) : u));

  /** a row's control by its class */
  const rowControl = <T extends HTMLElement>(email: string, cls: string): T | null =>
    [...list.querySelectorAll<HTMLElement>('.wiki-members-row')].find((r) => r.dataset['email'] === email)?.querySelector<T>(`.${cls}`) ??
    null;

  /** show a row's commit-address field (in place of its add button), holding `value` */
  const openAliasField = (email: string, value: string): HTMLInputElement | null => {
    const input = rowControl<HTMLInputElement>(email, 'wiki-members-alias-input');
    const add = rowControl<HTMLButtonElement>(email, 'wiki-members-alias-add');
    if (!input || !add) return null;
    add.hidden = true;
    input.hidden = false;
    input.value = value;
    return input;
  };

  const roleSelect = (value: string, label: string, onchange: (role: string) => void): HTMLSelectElement =>
    h(
      'select',
      { class: 'wiki-members-role', 'aria-label': label, onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
      ...data.roles.map((r) => h('option', { value: r, selected: r === value }, r)),
    );

  const savedName = (u: IdentityUser): string => users.find((x) => x.email === u.email)?.name ?? u.name;

  const nameField = (u: IdentityUser): HTMLInputElement => {
    const field = h('input', {
      class: 'wiki-members-name',
      value: u.name,
      maxlength: 60,
      spellcheck: 'false',
      'aria-label': S.identity.nameLabel(u.email),
    });
    const commit = (): void => {
      const name = field.value.trim();
      if (name === savedName(u)) return;
      if (name === '') {
        field.value = savedName(u);
        return;
      }
      void save(withMember(u.email, (x) => ({ ...x, name })), S.identity.renamed(name)).then((ok) => {
        if (ok) return;
        const again = rowControl<HTMLInputElement>(u.email, 'wiki-members-name');
        if (!again) return;
        again.value = name;
        again.focus();
      });
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        field.value = savedName(u);
      }
    });
    field.addEventListener('blur', commit);
    return field;
  };

  const aliasRow = (u: IdentityUser): HTMLElement => {
    const chips = (u.aliases ?? []).map((a) =>
      h(
        'li',
        { class: 'wiki-members-alias' },
        h('span', {}, a),
        h(
          'button',
          {
            type: 'button',
            class: 'wiki-members-alias-x',
            'aria-label': S.identity.removeAlias(a),
            onclick: () => void save(withMember(u.email, (x) => ({ ...x, aliases: (x.aliases ?? []).filter((y) => y !== a) })), S.identity.saved),
          },
          icon('close'),
        ),
      ),
    );
    const input = h('input', {
      class: 'wiki-members-alias-input',
      type: 'email',
      placeholder: S.identity.aliasPlaceholder,
      'aria-label': S.identity.addAliasLabel(u.name),
      hidden: true,
    });
    const add = h('button', { type: 'button', class: 'wiki-members-alias-add' }, S.identity.addAlias);
    const close = (): void => {
      input.value = '';
      input.hidden = true;
      add.hidden = false;
    };
    add.addEventListener('click', () => openAliasField(u.email, '')?.focus());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        add.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const alias = input.value.trim().toLowerCase();
        if (!alias.includes('@')) {
          toast(S.identity.emailRequired, 'err');
          return;
        }
        close();
        void save(withMember(u.email, (x) => ({ ...x, aliases: [...(x.aliases ?? []), alias] })), S.identity.aliasAdded(alias)).then((ok) => {
          if (!ok) openAliasField(u.email, alias)?.focus();
        });
      }
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim()) close();
    });
    return h(
      'div',
      { class: 'wiki-members-aliases' },
      h('span', { class: 'wiki-members-aliases-label', title: S.identity.aliasHint }, S.identity.aliasesLabel),
      h('ul', { role: 'list' }, ...chips, h('li', {}, add, input)),
    );
  };

  const removeButton = (u: IdentityUser): HTMLElement => {
    if (u.email === me) return h('span', { class: 'wiki-members-self' }, S.identity.you);
    const armed = confirming === u.email;
    return h(
      'button',
      {
        type: 'button',
        class: armed ? 'wiki-members-remove armed' : 'wiki-members-remove',
        'aria-label': armed ? S.identity.confirmRemove(u.name) : S.identity.removeLabel(u.name),
        onclick: () => {
          if (confirming !== u.email) {
            confirming = u.email;
            render();
            rowControl<HTMLButtonElement>(u.email, 'wiki-members-remove')?.focus();
            setTimeout(() => {
              if (confirming === u.email) {
                confirming = null;
                render();
              }
            }, 4000);
            return;
          }
          confirming = null;
          void save((current) => current.filter((x) => x.email !== u.email), S.identity.removed(u.name));
        },
      },
      armed ? S.identity.confirmRemoveShort : S.identity.remove,
    );
  };

  const matches = (u: IdentityUser, handle: string): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [u.name, u.email, handle, ...(u.aliases ?? [])].some((s) => s.toLowerCase().includes(q));
  };

  const focusNow = (): Focus | null => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !list.contains(el)) return null;
    const row = el.closest<HTMLElement>('.wiki-members-row')?.dataset['email'];
    if (!row) return null;
    const input = el instanceof HTMLInputElement ? el : null;
    return { row, cls: el.classList[0] ?? '', value: input?.value ?? null, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
  };

  const giveBack = (focus: Focus): void => {
    if (focus.cls === 'wiki-members-alias-input' && focus.value !== null) {
      const input = openAliasField(focus.row, focus.value);
      input?.focus();
      if (input && focus.start !== null && focus.end !== null) input.setSelectionRange(focus.start, focus.end);
      return;
    }
    const target = rowControl<HTMLElement>(focus.row, focus.cls);
    if (!target) return;
    if (target instanceof HTMLInputElement && focus.value !== null) target.value = focus.value;
    target.focus();
    if (target instanceof HTMLInputElement && focus.start !== null && focus.end !== null) target.setSelectionRange(focus.start, focus.end);
  };

  const render = (): void => {
    const focus = focusNow();
    const people = peopleOf(users);
    const shown = users.map((u, i) => ({ u, handle: people[i]!.handle })).filter(({ u, handle }) => matches(u, handle));
    count.textContent = S.identity.count(users.length);
    list.replaceChildren(
      ...shown.map(({ u, handle }) =>
        h(
          'li',
          { class: 'wiki-members-row', dataset: { email: u.email } },
          h(
            'span',
            { class: u.role === data.adminRole ? 'wiki-members-mark admin' : 'wiki-members-mark', 'aria-hidden': 'true' },
            [...u.name][0]?.toUpperCase() ?? '?',
          ),
          h(
            'div',
            { class: 'wiki-members-who' },
            nameField(u),
            h('div', { class: 'wiki-members-ids' }, h('span', { class: 'wiki-members-handle' }, `@${handle}`), h('span', {}, u.email)),
            aliasRow(u),
          ),
          h(
            'div',
            { class: 'wiki-members-actions' },
            roleSelect(u.role, S.identity.roleLabel(u.name), (role) => void save(withMember(u.email, (x) => ({ ...x, role })), S.identity.saved)),
            removeButton(u),
          ),
        ),
      ),
    );
    if (shown.length === 0) list.append(h('li', { class: 'wiki-members-empty' }, S.identity.noMatch(query.trim())));
    if (focus) giveBack(focus);
  };

  const search = h('input', {
    class: 'wiki-members-search',
    type: 'search',
    placeholder: S.identity.searchPlaceholder,
    'aria-label': S.identity.searchPlaceholder,
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      render();
    },
  });

  const email = h('input', { type: 'email', placeholder: S.identity.emailPlaceholder, 'aria-label': S.identity.colEmail, required: true });
  const name = h('input', { placeholder: S.identity.namePlaceholder, 'aria-label': S.identity.colName, maxlength: 60 });
  const role = roleSelect(data.defaultRole, S.identity.colRole, () => {});
  const addForm = h(
    'form',
    {
      class: 'wiki-members-add',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const addr = email.value.trim().toLowerCase();
        if (!addr.includes('@')) {
          toast(S.identity.emailRequired, 'err');
          return;
        }
        const added = name.value.trim() || (addr.split('@')[0] ?? addr);
        if (await save((current) => [...current, { email: addr, name: added, role: role.value }], S.identity.added(added))) {
          email.value = '';
          name.value = '';
        }
      },
    },
    h('span', { class: 'wiki-members-add-label' }, S.identity.addTitle),
    email,
    name,
    role,
    h('button', { class: 'wiki-btn wiki-btn-primary', type: 'submit' }, S.identity.add),
  );

  dialog.append(
    h(
      'header',
      { class: 'wiki-members-head' },
      h('h2', { id: 'wiki-members-title' }, S.identity.title, count),
      search,
      h('button', { type: 'button', class: 'wiki-members-close', 'aria-label': S.identity.close, onclick: () => dialog.close() }, icon('close')),
    ),
    h('p', { class: 'wiki-members-lede' }, S.identity.lede),
    list,
    h('footer', { class: 'wiki-members-foot' }, addForm, h('p', { class: 'wiki-members-note' }, S.identity.adminNote(data.adminRole))),
  );
  // a click on the backdrop (the dialog box itself, outside its content) closes it
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  // closed means gone: the next opening reads the registry afresh
  dialog.addEventListener('close', () => dialog.remove());
  render();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
