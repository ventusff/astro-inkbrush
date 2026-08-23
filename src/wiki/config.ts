/**
 * CMS component configuration — the types behind the site root's
 * `inkbrush.config.ts` (git-ignored; template: inkbrush.config.example.ts).
 * It configures CMS features only — formatting, routing, deploy domains and
 * other site concerns stay in the site's own astro.config. One machine, one
 * config:
 *
 *  - secrets NEVER live here — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are
 *    read from the environment where they're used; this file only toggles
 *    features and lists non-secret parameters;
 *  - having no inkbrush.config.ts at all is valid: defaults give dev login only,
 *    no Google, no inbox watcher, no autocommit.
 *
 * Only types + the identity helper live in this module so the root config
 * file can import it without pulling in any server code.
 */
import type { LocaleDef, LocaleInput } from './shared/locales.ts';

export type { LocaleDef, LocaleInput };

export interface GoogleAuthConfig {
  /** allowed Workspace domains and/or full addresses, e.g. ['acme.com',
   *  'bob@gmail.com']. Fail-closed: omitted/empty admits NOBODY — a
   *  deployment must list its domains; ['*'] explicitly admits every
   *  Google account */
  allowedDomains?: string[];
  /** external base URL for the OAuth callback (default: the request host —
   *  set this behind a reverse proxy / on a named domain) */
  baseUrl?: string;
}

export interface GoogleSamlAuthConfig {
  /** IdP SSO redirect URL (issued by the Google Admin console, shaped like
   *  https://accounts.google.com/o/saml2/idp?idpid=…) */
  entryPoint: string;
  /** IdP entity id (issued by Google, shaped like
   *  https://accounts.google.com/o/saml2?idpid=…) */
  idpEntityId: string;
  /** path to the IdP signing certificate (supports `~/` and paths relative to
   *  the site root). Three shapes are accepted: full multi-line PEM / bare
   *  base64 body / a whole `base64 -w0 cert.pem` blob */
  certFile: string;
  /** allowed email domains and/or full addresses. Fail-closed, same policy
   *  as Google OAuth: omitted/empty admits NOBODY — a deployment must list
   *  its domains; ['*'] explicitly admits every asserted email */
  allowedDomains?: string[];
  /** external base URL of the site — SP entityID and ACS URL derive from it
   *  (required):
   *  entityID = `<baseUrl>/api/wiki/auth/saml/metadata`
   *  ACS      = `<baseUrl>/api/wiki/auth/saml/callback` */
  baseUrl: string;
}

export interface SessionConfig {
  /** 'hmac' (default: cookie signed with `.wiki/secret`, single-site
   *  deployments) | 'jwt' (jose HS256, secret from the AUTH_SECRET env var —
   *  startup error when missing; for cross-subdomain SSO: sibling apps
   *  sharing the secret and a cookie Domain share the session) */
  format?: 'hmac' | 'jwt';
  /** cookie name (default 'wiki_session') */
  cookieName?: string;
  /** cookie Domain attribute (e.g. '.example.com' to share across
   *  subdomains); default host-only */
  cookieDomain?: string;
  /** session lifetime in days (default: jwt 7 / hmac 30) */
  ttlDays?: number;
  /** whitelist of off-site origins the login flow may redirect back to
   *  (e.g. ['https://app.example.com']); relative paths are always allowed,
   *  off-site origins must be listed here (open-redirect guard) */
  trustedOrigins?: string[];
}

export interface ShareGatewayConfig {
  /** admin API base of a static-snapshot gateway — any service implementing
   *  `PUT/DELETE/GET /admin/s/<id>` with Bearer auth (e.g.
   *  'http://gateway.internal:8787'). The admin token comes from the
   *  SHARE_GATEWAY_TOKEN env var and never enters this file */
  gatewayUrl: string;
  /** public base recipients open (e.g. 'https://share.example.com') —
   *  share links are `<publicBase>/s/<id>/` */
  publicBase: string;
}

export interface IdentityConfig {
  /** directory holding users.json (supports `~/` and paths relative to the
   *  site root); configuring this section = enabling the identity registry.
   *  The file is plain JSON — [{ email, name, role }] — and can be shared on
   *  disk with other apps on the same machine */
  dir: string;
  /** role vocabulary (default [defaultRole, adminRole]); must contain the
   *  two roles below */
  roles?: string[];
  /** role auto-assigned on first SSO login (default 'member') */
  defaultRole?: string;
  /** admin role name (default 'admin') — admins manage the member list; the
   *  server enforces that at least one admin always remains */
  adminRole?: string;
  /** register an unknown SSO user with defaultRole at first login (default
   *  true); false refuses unknown users at login */
  autoRegister?: boolean;
}

export interface ServerConfig {
  /** honor x-forwarded-host / x-forwarded-proto / x-forwarded-for from the
   *  incoming request (default false). Set true ONLY when the dev server
   *  sits behind a reverse proxy that overwrites these headers; a directly
   *  exposed server must leave it off, or any client can forge its origin
   *  and protocol */
  trustProxy?: boolean;
}

export interface WikiConfigInput {
  /** how the server reads its own environment (proxy trust) */
  server?: ServerConfig;
  auth?: {
    /** dev quick-login (name + email, no password) — local machines and
     *  private networks. Omitted, the default (true) serves LOOPBACK
     *  clients only (127.0.0.1/::1, direct socket, no forwarding header);
     *  an explicit `dev: true` serves every client, `false` disables it */
    dev?: boolean;
    /** Google Workspace login; `false` or omitted = off. When enabled the
     *  client id/secret still come from env (GOOGLE_CLIENT_ID /
     *  GOOGLE_CLIENT_SECRET). */
    google?: false | GoogleAuthConfig;
    /** Google Workspace SAML SSO (a custom SAML app in the Admin console);
     *  `false` or omitted = off */
    googleSaml?: false | GoogleSamlAuthConfig;
    /** session cookie behaviour (omitted = the defaults: hmac-signed,
     *  wiki_session, host-only, 30 days) */
    session?: SessionConfig;
  };
  /** identity registry (users.json: email/name/role); omitted = module off.
   *  When on, first SSO login auto-registers with defaultRole, admins manage
   *  members from the account panel, and the first admin(s) are seeded from
   *  the ADMIN_EMAILS env var (when users.json doesn't exist yet) */
  identity?: IdentityConfig;
  inbox?: {
    /** Obsidian inbox watch directory (supports `~/`); omitted or empty =
     *  watcher off */
    dir?: string;
    /** filenames/paths to skip during import. Each entry is tested as a
     *  prefix of the note's vault-relative path AND of its basename —
     *  e.g. ['daily/'] skips a folder, ['scratch-'] skips files by name.
     *  Default [] */
    ignore?: string[];
  };
  /** git-commit in the content repo after every wiki save (author = the
   *  signed-in user). default false */
  autocommit?: boolean;
  /** async git push of the content repo after each autocommit (turn on for
   *  deployment machines). default false */
  autopush?: boolean;
  /** the AI endpoints: which claude CLI runs the jobs, and what a job may see */
  claude?: {
    /** executable (default 'claude') */
    bin?: string;
    /** `--model` override (default: the CLI's own default) */
    model?: string;
    /** project-relative files or directories a job may read and change
     *  beside the note's own directory — e.g. the demo module a note
     *  mounts. Called per job with the note; default: none */
    companions?: (note: { id: string; file: string; dir: string; source: string }) => string[];
    /** the site's own writing constraints, appended to the dialect's in
     *  every prompt (component vocabulary, heading attributes, generated
     *  numbering, …). Default [] */
    rules?: string[];
  };
  content?: {
    /** note content directory, relative to the site root.
     *  default 'src/content/notes' */
    dir?: string;
    /** the note language table (default: zh unprefixed + en/ + de/). Exactly
     *  one entry must have prefix '' — that locale is the default and its
     *  notes live unprefixed at the content root */
    locales?: LocaleInput[];
  };
  /** public sharing (password-gated static snapshots of single notes, pushed
   *  to a snapshot gateway); `false` or omitted = off (routes 404, button not
   *  mounted — zero behaviour change) */
  share?: false | ShareGatewayConfig;
}

/** fully resolved config — defaults + env overrides applied (server/config.ts) */
export interface WikiConfig {
  server: { trustProxy: boolean };
  auth: {
    dev: boolean;
    /** the dev flag is set explicitly (config file or WIKI_DEV_LOGIN);
     *  a merely-defaulted true serves loopback clients only */
    devExplicit: boolean;
    google: false | { allowedDomains: string[]; baseUrl: string | null };
    googleSaml:
      | false
      | {
          entryPoint: string;
          idpEntityId: string;
          /** absolute path ('' = not set) */
          certFile: string;
          allowedDomains: string[];
          baseUrl: string;
        };
    session: {
      format: 'hmac' | 'jwt';
      cookieName: string;
      cookieDomain: string | null;
      ttlDays: number;
      trustedOrigins: string[];
    };
  };
  /** null = identity module off */
  identity: null | { dir: string; roles: string[]; defaultRole: string; adminRole: string; autoRegister: boolean };
  inbox: {
    /** absolute path, or null = watcher disabled */
    dir: string | null;
    /** resolved skip list (see WikiConfigInput.inbox.ignore) */
    ignore: string[];
  };
  autocommit: boolean;
  autopush: boolean;
  claude: {
    bin: string;
    model: string | null;
    companions: ((note: { id: string; file: string; dir: string; source: string }) => string[]) | null;
    rules: string[];
  };
  content: { dir: string; locales: readonly LocaleDef[] };
  /** false = share module off (the token only ever lives in the
   *  SHARE_GATEWAY_TOKEN env var) */
  share: false | { gatewayUrl: string; publicBase: string };
}

/** identity helper — gives the root inkbrush.config.ts type checking + completion */
export function defineInkbrushConfig(config: WikiConfigInput): WikiConfigInput {
  return config;
}

/** public type aliases: inkbrush = the component name (the implementation
 *  keeps wiki = the feature name as its internal namespace) */
export type InkbrushConfig = WikiConfig;
export type InkbrushConfigInput = WikiConfigInput;
