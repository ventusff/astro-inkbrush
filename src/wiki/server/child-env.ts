/**
 * Environment allowlist for child processes the CMS spawns (the claude CLI,
 * the snapshot build). A child receives only the variables it needs to run:
 * the base set below plus whatever names/prefixes the caller adds. Server
 * secrets (AUTH_SECRET, SHARE_GATEWAY_TOKEN, GOOGLE_*, WIKI_*, INKBRUSH_*)
 * are not in any allowlist and never reach a child.
 */

/** always inherited: process basics, locale, temp dir and proxy settings */
const BASE_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);
const BASE_PREFIXES = ['LC_'];

/**
 * The allowlisted subset of `process.env`: the base set, plus `names` and
 * `prefixes`, minus `drop` (which wins over every allow rule).
 */
export function childEnv(
  opts: { names?: string[]; prefixes?: string[]; drop?: string[] } = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const names = new Set([...BASE_NAMES, ...(opts.names ?? [])]);
  const prefixes = [...BASE_PREFIXES, ...(opts.prefixes ?? [])];
  const drop = new Set(opts.drop ?? []);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || drop.has(key)) continue;
    if (!names.has(key) && !prefixes.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}
