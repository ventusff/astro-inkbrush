/**
 * astro-inkbrush (CMS component) config template — copy to the site root as
 * `inkbrush.config.ts` (git-ignored) and adjust per machine. It configures
 * CMS features only; formatting, routing, deploy domains and other site
 * concerns belong to the site's own astro.config. Secrets always come from
 * environment variables and never enter this file.
 * Running without an inkbrush.config.ts is fine: the defaults give dev login
 * only, with everything else off.
 */
import { defineInkbrushConfig } from 'astro-inkbrush/config';

export default defineInkbrushConfig({
  // How the server reads its own environment. trustProxy (default false)
  // makes the server honor x-forwarded-host / x-forwarded-proto /
  // x-forwarded-for from incoming requests: set it true ONLY when the dev
  // server sits behind a reverse proxy (traefik/nginx) that overwrites
  // those headers — on a directly exposed server they are client input,
  // and trusting them lets anyone forge the request origin.
  // server: { trustProxy: true },
  auth: {
    // Local quick login (name + email, no password). Omitted, the default
    // serves LOOPBACK clients only (127.0.0.1/::1, no reverse proxy in
    // between); an explicit `dev: true` — as here — serves every client and
    // MUST be off for anything externally reachable.
    dev: true,
    // Google Workspace login: false = off. When enabled, secrets come from
    // the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars, and the OAuth
    // callback uses baseUrl. allowedDomains is fail-closed: an empty list
    // admits NOBODY — list your domains (['*'] = any Google account):
    // google: { allowedDomains: ['your-team.com'], baseUrl: 'https://wiki.example.com' },
    google: false,
    // Google Workspace SAML SSO (Admin console → custom SAML app).
    // The SP side needs no private key; certFile is the IdP signing
    // certificate (full PEM / bare base64 body / whole base64 blob all work;
    // the path supports ~/ and site-root-relative). allowedDomains follows
    // the same fail-closed policy as google above: an empty list admits
    // NOBODY — list your domains. SP entityID/ACS derive from baseUrl:
    //   entityID = <baseUrl>/api/wiki/auth/saml/metadata
    //   ACS      = <baseUrl>/api/wiki/auth/saml/callback
    // googleSaml: {
    //   entryPoint: 'https://accounts.google.com/o/saml2/idp?idpid=…', // SSO URL
    //   idpEntityId: 'https://accounts.google.com/o/saml2?idpid=…',
    //   certFile: '.wiki/saml-idp.pem',
    //   allowedDomains: ['your-team.com'],
    //   baseUrl: 'https://wiki.example.com',
    // },
    // Session cookie (omit = the defaults: hmac-signed, named wiki_session,
    // host-only, 30 days). Cross-subdomain SSO: jwt format (HS256, secret
    // from the AUTH_SECRET env var — startup error when missing) + a shared
    // cookie Domain; off-site return targets must be whitelisted in
    // trustedOrigins:
    // session: {
    //   format: 'jwt',
    //   cookieName: 'team_session',
    //   cookieDomain: '.example.com',
    //   ttlDays: 7,
    //   trustedOrigins: ['https://app.example.com'],
    // },
  },
  // Identity registry (<dir>/users.json: email/name/role; omit = module off).
  // When on, only registered members may edit; admins (adminRole — the
  // server always keeps at least one) manage members from the account
  // panel, and the ADMIN_EMAILS env var seeds users.json when it does not
  // exist yet. autoRegister (default true) lets a first SSO login from an
  // allowed domain join with defaultRole; false makes the registry an
  // allow-list that only admins extend.
  // identity: {
  //   dir: '.wiki/identity',
  //   roles: ['member', 'admin'],
  //   defaultRole: 'member',
  //   adminRole: 'admin',
  //   autoRegister: true,
  // },
  inbox: {
    // Obsidian inbox watch directory (supports ~/); omit or leave empty = off
    // dir: '~/vault/inbox',
    // Skip files during import: each entry is tested as a prefix of the
    // note's vault-relative path and of its basename (e.g. 'daily/' skips a
    // folder, 'scratch-' skips files by name). Default: [].
    // ignore: ['daily/', 'scratch-'],
  },
  // git-commit in the content repo after every save (author = the signed-in
  // user; default off)
  autocommit: false,
  // async git push after each autocommit (turn on for deployment machines;
  // default off)
  // autopush: true,
  // The AI endpoints. Every job runs in a throwaway copy that holds the
  // note's directory; `companions` names further project-relative files or
  // directories the job may read and change for that note (e.g. the demo
  // module it mounts), and `rules` appends the site's own writing
  // constraints to the dialect's in every prompt.
  // claude: {
  //   bin: 'claude',                 // default 'claude'
  //   model: 'claude-opus-4-8',      // default: the CLI's own
  //   companions: (note) => [`src/demos/${note.id}.ts`],
  //   rules: ['Headings keep their {#anchor} attributes.'],
  // },
  content: {
    // note content directory, relative to the site root
    // (default 'src/content/notes')
    // dir: 'src/content/notes',
    // note language table. Exactly one entry has prefix '' — that locale is
    // the default and its notes live unprefixed. Default: Chinese unprefixed
    // + en/ + de/. An English-first site would use:
    // locales: [
    //   { code: 'en', prefix: '', label: 'English', promptName: 'English', appendixTitle: 'Appendix' },
    //   { code: 'zh', prefix: 'zh/', label: '中文', promptName: '中文', appendixTitle: '附录' },
    // ],
  },
  // Public sharing (password-gated static snapshots of single notes;
  // false/omitted = off). gatewayUrl = the admin API of any static-snapshot
  // gateway implementing `PUT/DELETE/GET /admin/s/<id>` with Bearer auth;
  // publicBase = the public host recipients open (link =
  // <publicBase>/s/<id>/). The admin token comes from the
  // SHARE_GATEWAY_TOKEN env var and never enters this file.
  // prewarm keeps the cached snapshot build fresh in the background (a
  // rebuild once the site has been quiet for 30 s after a change), so a
  // share spends only the seconds of packing and uploading.
  // share: {
  //   gatewayUrl: 'http://gateway.internal:8787',
  //   publicBase: 'https://share.example.com',
  //   prewarm: true,
  // },
});
