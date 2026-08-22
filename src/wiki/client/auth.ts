/**
 * Session chip — the account button on every page. Signed out → a ghost
 * "Sign in" button opening a popover with whatever the deployment's
 * inkbrush.config.ts enables: the Google Workspace buttons (hidden when off,
 * greyed out while env secrets are missing) and/or the dev quick-login form.
 * Signed in → avatar + name, popover with sign-out.
 *
 * Mount contract (same philosophy as `<meta name="inkbrush-note">` — the site
 * declares, the CMS discovers): if the site's chrome contains
 * `[data-inkbrush-slot="account"]`, the chip mounts there as a normal flow
 * element (never covering the site's own corner controls, e.g. a theme
 * toggle); with no slot it falls back to a fixed top-right position, tunable
 * via `--wiki-chip-top` / `--wiki-chip-right`.
 */
import type { GoogleAuthState, MeResponse, WikiUser } from '../shared/types';
import { api } from './api';
import { S } from './strings';
import { dismissPopover, h, popover, toast, uid } from './ui';

let me: MeResponse = { user: null, providers: { dev: false, google: 'off', googleSaml: 'off' }, share: 'off' };
const listeners = new Set<(user: WikiUser | null) => void>();

export function currentUser(): WikiUser | null {
  return me.user;
}

/** share module availability as reported by /me (valid after mountAuthChip) */
export function shareAvailability(): GoogleAuthState {
  return me.share;
}

export function onAuthChange(fn: (user: WikiUser | null) => void): void {
  listeners.add(fn);
}

function notify(): void {
  for (const fn of listeners) fn(me.user);
}

/** Avatar. Decorative: the user's name is rendered right next to it (chip
 *  and account panel alike), so it is empty-alt / hidden for assistive
 *  technology. */
function avatar(user: WikiUser): HTMLElement {
  if (user.picture) {
    return h('img', { class: 'wiki-avatar', src: user.picture, alt: '', referrerpolicy: 'no-referrer' });
  }
  const initial = [...user.name][0]?.toUpperCase() ?? '?';
  return h('span', { class: 'wiki-avatar wiki-avatar-fallback', 'aria-hidden': 'true' }, initial);
}

/**
 * One SSO sign-in button. 'off' (disabled in inkbrush.config.ts) → not
 * rendered at all; 'unconfigured' → greyed out, with the missing-config
 * explanation as a visible hint the button also references via
 * aria-describedby.
 */
function ssoButton(state: GoogleAuthState, label: string, href: string, hintText: string): HTMLElement[] {
  if (state === 'off') return [];
  const ready = state === 'ready';
  const hintId = ready ? null : uid('auth-hint');
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'wiki-btn wiki-btn-google',
      disabled: !ready,
      ...(hintId ? { 'aria-describedby': hintId } : {}),
      onclick: () => {
        window.location.href = `${href}?return=${encodeURIComponent(window.location.pathname)}`;
      },
    },
    h('span', { class: 'wiki-g-mark', 'aria-hidden': 'true' }, 'G'),
    ` ${label}`,
    ready ? null : h('span', { class: 'wiki-badge-soft' }, S.auth.notConfigured),
  );
  return hintId ? [btn, h('div', { id: hintId, class: 'wiki-auth-hint' }, hintText)] : [btn];
}

function signedOutPanel(rerender: () => void): HTMLElement {
  const googleParts = ssoButton(
    me.providers.google,
    S.auth.googleButton,
    '/api/wiki/auth/google',
    S.auth.googleMissingEnv,
  );
  const samlParts = ssoButton(
    me.providers.googleSaml,
    S.auth.samlButton,
    '/api/wiki/auth/saml/login',
    S.auth.samlMissingConfig,
  );

  const name = h('input', {
    class: 'wiki-input',
    placeholder: S.auth.nickname,
    'aria-label': S.auth.nickname,
    autocomplete: 'nickname',
  });
  const email = h('input', {
    class: 'wiki-input',
    type: 'email',
    placeholder: S.auth.emailPlaceholder,
    'aria-label': S.auth.emailPlaceholder,
    autocomplete: 'email',
  });
  const submit = async (): Promise<void> => {
    try {
      const { user } = await api.post<{ user: WikiUser }>('/auth/dev', {
        name: name.value,
        email: email.value,
      });
      // refetch /me so identity fields (role/siteRole) arrive with the session
      me = await api.get<MeResponse>('/me').catch(() => ({ ...me, user }));
      notify();
      rerender();
      dismissPopover();
      toast(S.auth.signedIn(user.name));
    } catch (err) {
      toast(err instanceof Error ? err.message : S.auth.signInFailed, 'err');
    }
  };
  const devForm = me.providers.dev
    ? h(
        'form',
        {
          class: 'wiki-dev-form',
          onsubmit: (e: Event) => {
            e.preventDefault();
            void submit();
          },
        },
        h('div', { class: 'wiki-form-label' }, S.auth.devLoginLabel),
        name,
        email,
        h('button', { class: 'wiki-btn wiki-btn-primary', type: 'submit' }, S.auth.enter),
      )
    : null;

  const ssoParts = [...samlParts, ...googleParts];
  return h(
    'div',
    { class: 'wiki-auth-panel' },
    h('div', { class: 'wiki-panel-title' }, S.auth.panelTitle),
    ...ssoParts,
    ssoParts.length && devForm ? h('div', { class: 'wiki-divider' }, h('span', {}, S.auth.or)) : null,
    devForm,
    !ssoParts.length && !devForm
      ? h('div', { class: 'wiki-form-label' }, S.auth.noProviders)
      : null,
  );
}

function signedInPanel(user: WikiUser, rerender: () => void, anchor: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'wiki-auth-panel' },
    h(
      'div',
      { class: 'wiki-auth-id' },
      avatar(user),
      h('div', {}, h('div', { class: 'wiki-auth-name' }, user.name), h('div', { class: 'wiki-auth-email' }, user.email)),
    ),
    h('div', { class: 'wiki-auth-provider' }, S.auth.provider[user.provider]),
    // identity module on → show the registry role (unregistered = —)
    me.siteRole !== undefined
      ? h('div', { class: 'wiki-auth-role' }, S.auth.role(me.role))
      : null,
    me.siteRole === 'admin'
      ? h(
          'button',
          {
            type: 'button',
            class: 'wiki-btn',
            onclick: async () => {
              const { openMembersPanel } = await import('./identity');
              await openMembersPanel(anchor);
            },
          },
          S.auth.members,
        )
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'wiki-btn',
        onclick: async () => {
          await api.post('/logout');
          me = { user: null, providers: me.providers, share: me.share };
          notify();
          rerender();
          dismissPopover();
          toast(S.auth.signedOut);
        },
      },
      S.auth.signOut,
    ),
  );
}

/** A provider flow that fails redirects to `?login_error=<code>`: surface the
 *  message once and drop the parameter from the address bar. */
function reportLoginError(): void {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('login_error');
  if (!code) return;
  url.searchParams.delete('login_error');
  window.history.replaceState(window.history.state, '', url);
  toast(S.auth.loginError(code), 'err');
}

export async function mountAuthChip(): Promise<void> {
  reportLoginError();
  try {
    me = await api.get<MeResponse>('/me');
  } catch {
    return; // API down — stay invisible
  }
  const chip = h('button', {
    type: 'button',
    class: 'wiki-chip',
    'aria-label': S.auth.chipLabel,
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
  });
  const render = (): void => {
    chip.replaceChildren(
      ...(me.user
        ? [avatar(me.user), h('span', { class: 'wiki-chip-name' }, me.user.name)]
        : [h('span', { class: 'wiki-chip-name wiki-chip-signin' }, S.auth.signIn)]),
    );
  };
  render();
  chip.addEventListener('click', () => {
    const rerender = (): void => render();
    popover(chip, me.user ? signedInPanel(me.user, rerender, chip) : signedOutPanel(rerender), {
      label: me.user ? S.auth.accountPanel : S.auth.panelTitle,
    });
  });
  const slotHost = document.querySelector('[data-inkbrush-slot="account"]');
  if (slotHost) {
    slotHost.append(h('div', { class: 'wiki-chip-slot wiki-chip-inslot' }, chip));
  } else {
    document.body.append(h('div', { class: 'wiki-chip-slot' }, chip));
  }
  notify();
}
