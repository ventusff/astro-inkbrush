/**
 * Members panel (identity module, admin only) — lazy-loaded from the account
 * popover. Table of users.json entries with a role dropdown (options = the
 * configured vocabulary), remove buttons and an add form. Every mutation PUTs
 * the whole list; while the PUT is pending the whole form is disabled, so no
 * edit can be entered that the save would drop. The server enforces the role
 * vocabulary and the at-least-one-admin invariant, and its 400s surface here
 * as toasts.
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

  // disable every control while a save is pending (render() re-enables by
  // rebuilding the panel)
  const disableForm = (): void => {
    for (const el of panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      'button, input, select',
    )) {
      el.disabled = true;
    }
    panel.setAttribute('aria-busy', 'true');
  };

  const save = async (next: IdentityUser[]): Promise<void> => {
    if (busy) return;
    busy = true;
    disableForm();
    try {
      const res = await api.put<{ users: IdentityUser[] }>('/identity/users', { users: next });
      users = res.users;
      toast(S.identity.saved);
    } catch (err) {
      toast(err instanceof Error ? err.message : S.identity.saveFailed, 'err');
    } finally {
      busy = false;
      render();
      panel.setAttribute('aria-busy', 'false');
    }
  };

  const roleSelect = (value: string, onchange: (role: string) => void): HTMLSelectElement =>
    h(
      'select',
      {
        class: 'wiki-input wiki-members-role',
        'aria-label': S.identity.colRole,
        onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value),
      },
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
              'aria-label': S.identity.removeLabel(u.email),
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

    const email = h('input', {
      class: 'wiki-input',
      type: 'email',
      placeholder: S.identity.emailPlaceholder,
      'aria-label': S.identity.colEmail,
    });
    const name = h('input', {
      class: 'wiki-input',
      placeholder: S.identity.namePlaceholder,
      'aria-label': S.identity.colName,
    });
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
            h('th', { 'aria-label': S.identity.colActions }),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
      addForm,
      h('div', { class: 'wiki-members-note' }, S.identity.adminNote(data.adminRole)),
    );
  };

  render();
  popover(anchor, panel, { label: S.identity.title });
}
