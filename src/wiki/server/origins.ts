/**
 * Trusted-origin matching — the ONE reading of auth.session.trustedOrigins,
 * shared by the CSRF gate and the login return-target check.
 *
 * An entry is either an exact origin (`https://plan.example.com`) or a
 * one-or-more-label wildcard (`https://*.example.com`): scheme and port must
 * match exactly, and the hostname must end with `.` + the suffix. The bare
 * apex (`https://example.com`) is NOT matched by the wildcard — list it
 * explicitly when it is trusted.
 */

/** true when `origin` (a serialized http(s) origin) matches one of `trusted` */
export function originTrusted(origin: string, trusted: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  for (const entry of trusted) {
    if (entry === origin) return true;
    const at = entry.indexOf('//*.');
    if (at < 0) continue;
    const scheme = entry.slice(0, at + 2); // 'https://'
    const rest = entry.slice(at + 4); // 'example.com[:port]'
    const colon = rest.indexOf(':');
    const suffix = colon < 0 ? rest : rest.slice(0, colon);
    const port = colon < 0 ? '' : rest.slice(colon + 1);
    if (`${url.protocol}//` !== scheme) continue;
    if (url.port !== port) continue;
    if (url.hostname.endsWith(`.${suffix}`)) return true;
  }
  return false;
}
