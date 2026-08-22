/**
 * Members panel (identity module, admin only) — lazy-loaded from the account
 * popover. Table of users.json entries with a role dropdown (options = the
 * configured vocabulary), remove buttons and an add form. Every mutation PUTs
 * the whole list; the server enforces the role vocabulary and the
 * at-least-one-admin invariant, and its 400s surface here as toasts.
 */
import type { IdentityUser, IdentityUsersResponse } from '../shared/types';
import { api } from './api';
import { S } from './strings';
import { h, popover, toast } from './ui';

export async function openMembersPanel(anchor: HTMLElement): Promise<void> {
  let data: IdentityUsersResponse;
  try {
    data = await api.get<IdentityUsersResponse>('/identity/users');
  } catch (err) {
    toast(err instanceof Error ? err.message : S.identity.loadFailed, 'err');
    return;
  }

  let users = data.users;
  let busy = false;
  const panel = h('div', { class: 'wiki-members' });

  const save = async (next: IdentityUser[]): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const res = await api.put<{ users: IdentityUser[] }>('/identity/users', { users: next });
      users = res.users;
      toast(S.identity.saved);
    } catch (err) {
      toast(err instanceof Error ? err.message : S.identity.saveFailed, 'err');
    }
    busy = false;
    render();
  };

  const roleSelect = (value: string, onchange: (role: string) => void): HTMLSelectElement =>
    h(
      'select',
      { class: 'wiki-input wiki-members-role', onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
      ...data.roles.map((r) => h('option', { value: r, selected: r === value }, r)),
    );

  const render = (): void => {
    const rows = users.map((u) =>
      h(
        'tr',
        {},
        h('td', { class: 'wiki-members-email', title: u.email }, u.email),
        h('td', { class: 'wiki-members-name', title: u.name }, u.name),
        h(
          'td',
          {},
          roleSelect(u.role, (role) => {
            void save(users.map((x) => (x.email === u.email ? { ...x, role } : x)));
          }),
        ),
        h(
          'td',
          {},
          h(
            'button',
            {
              class: 'wiki-members-remove',
              type: 'button',
              onclick: () => {
                if (!window.confirm(S.identity.confirmRemove(u.email))) return;
                void save(users.filter((x) => x.email !== u.email));
              },
            },
            S.identity.remove,
          ),
        ),
      ),
    );

    const email = h('input', { class: 'wiki-input', type: 'email', placeholder: 'name@team.com' });
    const name = h('input', { class: 'wiki-input', placeholder: S.identity.namePlaceholder });
    const role = roleSelect(data.defaultRole, () => {});
    const addForm = h(
      'form',
      {
        class: 'wiki-members-add',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const addr = email.value.trim().toLowerCase();
          if (!addr.includes('@')) {
            toast(S.identity.emailRequired, 'err');
            return;
          }
          void save([
            ...users,
            { email: addr, name: name.value.trim() || (addr.split('@')[0] ?? addr), role: role.value },
          ]);
        },
      },
      email,
      name,
      role,
      h('button', { class: 'wiki-btn wiki-btn-primary', type: 'submit' }, S.identity.add),
    );

    panel.replaceChildren(
      h('div', { class: 'wiki-panel-title' }, S.identity.title),
      h(
        'table',
        { class: 'wiki-members-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, S.identity.colEmail),
            h('th', {}, S.identity.colName),
            h('th', {}, S.identity.colRole),
            h('th', {}, ''),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
      addForm,
      h('div', { class: 'wiki-members-note' }, S.identity.adminNote(data.adminRole)),
    );
  };

  render();
  popover(anchor, panel);
}
