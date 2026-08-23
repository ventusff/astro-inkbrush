/**
 * Config value validators, called at config resolution so a misconfigured
 * deployment fails at startup with a message naming the field, not on the
 * first request that trips over it. Kept free of config/server imports so
 * every rule is unit-testable.
 */
import { isAbsolute } from 'node:path';

/** RFC 6265 cookie-name token characters */
const COOKIE_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** a DNS-name shape, optionally with the cookie-Domain leading dot */
const DOMAIN = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function checkCookieName(name: string): void {
  if (!COOKIE_TOKEN.test(name)) {
    throw new Error(
      `auth.session.cookieName '${name}' is not a valid cookie name (letters, digits and !#$%&'*+-.^_\`|~ only, no spaces)`,
    );
  }
}

export function checkCookieDomain(domain: string | null): void {
  if (domain === null) return;
  if (!DOMAIN.test(domain)) {
    throw new Error(
      `auth.session.cookieDomain '${domain}' is not a plausible domain (expected something like '.example.com')`,
    );
  }
}

/** every entry must be exactly an http(s) origin — scheme://host[:port] */
export function checkTrustedOrigins(origins: string[]): void {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`auth.session.trustedOrigins entry '${origin}' is not a URL`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) {
      throw new Error(
        `auth.session.trustedOrigins entry '${origin}' must be a bare http(s) origin (scheme://host[:port], no path)`,
      );
    }
  }
}

/** `value` must parse as an http(s) URL; `field` names it in the error.
 *  An empty value passes — emptiness is the field's own "unconfigured"
 *  state, reported through the provider state, not a startup error. */
export function checkHttpUrl(field: string, value: string | null): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} '${value}' is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} '${value}' must be an http(s) URL`);
  }
}

/** content.dir is a relative path inside the site (no absolute path, no
 *  '..' segment — the content root must resolve inside the project) */
export function checkContentDir(dir: string): void {
  if (!dir.trim()) throw new Error('content.dir must not be empty');
  if (isAbsolute(dir)) {
    throw new Error(`content.dir '${dir}' must be relative to the site root, not absolute`);
  }
  if (dir.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(`content.dir '${dir}' must not contain '..'`);
  }
}

export function checkAutopush(autocommit: boolean, autopush: boolean): void {
  if (autopush && !autocommit) {
    throw new Error('autopush requires autocommit (there is nothing to push without commits) — enable autocommit or drop autopush');
  }
}
