/**
 * Deployment config resolution: defaults ← root inkbrush.config.ts ← env overrides.
 *
 * The root file is discovered via import.meta.glob, so its absence is not an
 * error (a glob with no matches is just an empty record). The historical
 * WIKI_* environment variables stay honoured as per-process overrides — handy
 * for one-off runs (`WIKI_INBOX_DIR=/tmp/x` in a test) — but the config file
 * is the durable source of truth for each deployment.
 *
 * Secrets are intentionally NOT part of the config object: GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET are read where used (auth.ts), so a stray
 * console.log(wikiConfig()) can never leak them.
 *
 * After editing inkbrush.config.ts: request-level settings (login providers,
 * autocommit, claude) take effect immediately via SSR module hot reload; the
 * inbox watcher is created at dev-server startup, so changing the watch dir
 * requires a dev-server restart.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { WikiConfig, WikiConfigInput } from '../config';
import { resolveLocales } from '../shared/locales';
import { projectRoot } from './store';

const configModules = import.meta.glob<{ default: WikiConfigInput }>('/inkbrush.config.ts', {
  eager: true,
});

/** `~/…` → home; relative paths resolve against the project root */
function expandDir(dir: string): string {
  const expanded = dir === '~' ? homedir() : dir.startsWith('~/') ? homedir() + dir.slice(1) : dir;
  return resolve(projectRoot(), expanded);
}

/** unset/empty env → undefined; otherwise '0' = false, anything else = true */
function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  return value !== '0';
}

function envStr(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** comma-separated env list → trimmed entries; unset/empty → undefined */
function envList(name: string): string[] | undefined {
  return envStr(name)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

let cached: WikiConfig | null = null;

export function wikiConfig(): WikiConfig {
  if (cached) return cached;
  const input = Object.values(configModules)[0]?.default ?? {};

  const googleInput = input.auth?.google ?? false;
  const google: WikiConfig['auth']['google'] =
    googleInput === false
      ? false
      : {
          allowedDomains: envStr('WIKI_ALLOWED_DOMAIN')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ??
            googleInput.allowedDomains ?? [],
          baseUrl: (envStr('WIKI_BASE_URL') ?? googleInput.baseUrl)?.replace(/\/$/, '') ?? null,
        };

  // Google Workspace SAML SSO — like google: env only overrides fields of a
  // config-enabled provider (enabling itself is a config-file decision)
  const samlInput = input.auth?.googleSaml ?? false;
  const samlCertRaw = envStr('WIKI_SAML_CERT_FILE') ?? (samlInput === false ? '' : samlInput.certFile);
  const googleSaml: WikiConfig['auth']['googleSaml'] =
    samlInput === false
      ? false
      : {
          entryPoint: envStr('WIKI_SAML_SSO_URL') ?? samlInput.entryPoint ?? '',
          idpEntityId: envStr('WIKI_SAML_IDP_ENTITY_ID') ?? samlInput.idpEntityId ?? '',
          certFile: samlCertRaw.trim() ? expandDir(samlCertRaw.trim()) : '',
          allowedDomains: envList('WIKI_SAML_ALLOWED_DOMAIN') ?? samlInput.allowedDomains ?? [],
          baseUrl: ((envStr('WIKI_BASE_URL') ?? samlInput.baseUrl) || '').replace(/\/$/, ''),
        };

  // session cookie behaviour — defaults keep today's byte-identical shape
  // (hmac / wiki_session / host-only / 30d); jwt mode hard-requires AUTH_SECRET
  const sessionInput = input.auth?.session ?? {};
  const formatRaw = envStr('WIKI_SESSION_FORMAT') ?? sessionInput.format ?? 'hmac';
  if (formatRaw !== 'hmac' && formatRaw !== 'jwt') {
    throw new Error(`auth.session.format must be 'hmac' or 'jwt' (got '${formatRaw}')`);
  }
  const ttlRaw = envStr('WIKI_SESSION_TTL_DAYS');
  const session: WikiConfig['auth']['session'] = {
    format: formatRaw,
    cookieName: envStr('WIKI_COOKIE_NAME') ?? sessionInput.cookieName ?? 'wiki_session',
    cookieDomain: envStr('WIKI_COOKIE_DOMAIN') ?? sessionInput.cookieDomain ?? null,
    ttlDays:
      (ttlRaw !== undefined ? Number(ttlRaw) : undefined) ??
      sessionInput.ttlDays ??
      (formatRaw === 'jwt' ? 7 : 30),
    trustedOrigins: (envList('WIKI_TRUSTED_ORIGINS') ?? sessionInput.trustedOrigins ?? []).map(
      (o: string) => o.replace(/\/$/, ''),
    ),
  };
  if (!Number.isFinite(session.ttlDays) || session.ttlDays <= 0) {
    throw new Error(`auth.session.ttlDays must be a positive number (got '${String(session.ttlDays)}')`);
  }
  if (session.format === 'jwt' && !process.env['AUTH_SECRET']) {
    throw new Error(
      "auth.session.format 'jwt' requires the AUTH_SECRET environment variable (refusing to start without it)",
    );
  }

  // identity registry — module off unless a dir is configured
  const identityDirRaw = envStr('WIKI_IDENTITY_DIR') ?? input.identity?.dir ?? '';
  let identity: WikiConfig['identity'] = null;
  if (identityDirRaw.trim()) {
    const defaultRole = input.identity?.defaultRole ?? 'member';
    const adminRole = input.identity?.adminRole ?? 'admin';
    const roles = input.identity?.roles ?? [...new Set([defaultRole, adminRole])];
    if (!roles.includes(defaultRole) || !roles.includes(adminRole)) {
      throw new Error(
        `identity.roles must include defaultRole '${defaultRole}' and adminRole '${adminRole}'`,
      );
    }
    identity = { dir: expandDir(identityDirRaw.trim()), roles, defaultRole, adminRole };
  }

  // share module — like google/saml: enabling is a config-file decision, env
  // only overrides fields; the admin token is SHARE_GATEWAY_TOKEN (env only)
  const shareInput = input.share ?? false;
  const share: WikiConfig['share'] =
    shareInput === false
      ? false
      : {
          gatewayUrl: (envStr('WIKI_SHARE_GATEWAY_URL') ?? shareInput.gatewayUrl ?? '').replace(/\/$/, ''),
          publicBase: (envStr('WIKI_SHARE_PUBLIC_BASE') ?? shareInput.publicBase ?? '').replace(/\/$/, ''),
        };

  // WIKI_INBOX_DIR='' explicitly disables the watcher even when the config
  // file sets a dir (empty dir = off, per the config contract)
  const inboxRaw = process.env['WIKI_INBOX_DIR'] ?? input.inbox?.dir ?? '';

  cached = {
    auth: {
      dev: envFlag('WIKI_DEV_LOGIN') ?? input.auth?.dev ?? true,
      google,
      googleSaml,
      session,
    },
    identity,
    inbox: {
      dir: inboxRaw.trim() ? expandDir(inboxRaw.trim()) : null,
      ignore: envList('WIKI_INBOX_IGNORE') ?? input.inbox?.ignore ?? [],
    },
    autocommit: envFlag('WIKI_AUTOCOMMIT') ?? input.autocommit ?? false,
    autopush: envFlag('WIKI_AUTOPUSH') ?? input.autopush ?? false,
    claude: {
      bin: envStr('WIKI_CLAUDE_BIN') ?? input.claude?.bin ?? 'claude',
      model: envStr('WIKI_CLAUDE_MODEL') ?? input.claude?.model ?? null,
    },
    content: {
      dir: input.content?.dir ?? 'src/content/notes',
      locales: resolveLocales(input.content?.locales),
    },
    share,
  };
  return cached;
}
