/**
 * Deployment config resolution: defaults ← root inkbrush.config.ts ← env
 * overrides.
 *
 * The root file is discovered via import.meta.glob; its absence is valid
 * (the defaults apply). The WIKI_* environment variables are per-process
 * overrides of individual fields; the config file is each deployment's
 * source of truth.
 *
 * Secrets are not part of the config object: GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET / AUTH_SECRET / SHARE_GATEWAY_TOKEN are read where
 * used, so the resolved config can be logged.
 *
 * Request-level settings (login providers, autocommit, claude) take effect
 * on SSR module reload after the file changes; the inbox watcher is created
 * at dev-server startup, so a changed watch dir needs a restart.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { WikiConfig, WikiConfigInput } from '../config.ts';
import { resolveLocales } from '../shared/locales.ts';
import {
  checkAutopush,
  checkContentDir,
  checkCookieDomain,
  checkCookieName,
  checkHttpUrl,
  checkTrustedOrigins,
} from './config-checks.ts';
import { projectRoot } from './store.ts';

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

/** a non-negative number of minutes, from the config file or an env string */
function minutes(key: string, value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${key} must be a non-negative number of minutes (got ${JSON.stringify(value)})`);
  }
  return n;
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

  // proxy trust is opt-in: without it, forwarded headers are attacker input
  const server: WikiConfig['server'] = {
    trustProxy: envFlag('WIKI_TRUST_PROXY') ?? input.server?.trustProxy ?? false,
  };

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

  // session cookie behaviour (defaults: hmac / wiki_session / host-only /
  // 30 days); jwt mode requires AUTH_SECRET
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
    if (roles.some((r) => typeof r !== 'string' || !r.trim())) {
      throw new Error('identity.roles must be non-empty strings');
    }
    if (new Set(roles).size !== roles.length) {
      throw new Error(`identity.roles contains duplicates (${roles.join(', ')})`);
    }
    if (!roles.includes(defaultRole) || !roles.includes(adminRole)) {
      throw new Error(
        `identity.roles must include defaultRole '${defaultRole}' and adminRole '${adminRole}'`,
      );
    }
    identity = {
      dir: expandDir(identityDirRaw.trim()),
      roles,
      defaultRole,
      adminRole,
      autoRegister: input.identity?.autoRegister ?? true,
    };
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
          prewarm: envFlag('WIKI_SHARE_PREWARM') ?? shareInput.prewarm ?? false,
          followIdleMinutes: minutes(
            'share.followIdleMinutes',
            envStr('WIKI_SHARE_FOLLOW_IDLE_MINUTES') ?? shareInput.followIdleMinutes ?? 20,
          ),
        };

  // WIKI_INBOX_DIR='' explicitly disables the watcher even when the config
  // file sets a dir (empty dir = off, per the config contract)
  const inboxRaw = process.env['WIKI_INBOX_DIR'] ?? input.inbox?.dir ?? '';

  // dev login: the default (nothing set anywhere) is loopback-only at the
  // route; only an explicit config/env value serves non-loopback clients
  const devFlag = envFlag('WIKI_DEV_LOGIN');
  const resolved: WikiConfig = {
    server,
    auth: {
      dev: devFlag ?? input.auth?.dev ?? true,
      devExplicit: devFlag !== undefined || input.auth?.dev !== undefined,
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
      companions: input.claude?.companions ?? null,
      rules: input.claude?.rules ?? [],
    },
    content: {
      dir: input.content?.dir ?? 'src/content/notes',
      locales: resolveLocales(input.content?.locales),
    },
    share,
  };

  // value validation (./config-checks.ts): a malformed field fails here, at
  // resolution, with a message naming it — never on the first request
  checkCookieName(resolved.auth.session.cookieName);
  checkCookieDomain(resolved.auth.session.cookieDomain);
  checkTrustedOrigins(resolved.auth.session.trustedOrigins);
  if (resolved.auth.google !== false) checkHttpUrl('auth.google.baseUrl', resolved.auth.google.baseUrl);
  if (resolved.auth.googleSaml !== false) {
    checkHttpUrl('auth.googleSaml.baseUrl', resolved.auth.googleSaml.baseUrl);
  }
  if (resolved.share !== false) {
    checkHttpUrl('share.gatewayUrl', resolved.share.gatewayUrl);
    checkHttpUrl('share.publicBase', resolved.share.publicBase);
  }
  checkContentDir(resolved.content.dir);
  checkAutopush(resolved.autocommit, resolved.autopush);

  cached = resolved;
  return cached;
}
