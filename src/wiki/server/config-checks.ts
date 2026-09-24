/**
 * Config value validators, called at config resolution so a misconfigured
 * deployment fails at startup with a message naming the field, not on the
 * first request that trips over it. Kept free of config/server imports so
 * every rule is unit-testable.
 */
import { isAbsolute } from 'node:path';

import type { SyndicationPeer } from '../config.ts';
import { checkBranchName } from '../../lib/git-ref-name.ts';
import { SYNDICATION_NAME } from '../../lib/syndication-state.ts';

export { checkBranchName };

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

/** every entry must be exactly an http(s) origin — scheme://host[:port] —
 *  or a subdomain wildcard of one: scheme://*.host[:port] (origins.ts) */
export function checkTrustedOrigins(origins: string[]): void {
  for (const origin of origins) {
    const probe = origin.replace('//*.', '//wildcard-label.');
    let url: URL;
    try {
      url = new URL(probe);
    } catch {
      throw new Error(`auth.session.trustedOrigins entry '${origin}' is not a URL`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== probe) {
      throw new Error(
        `auth.session.trustedOrigins entry '${origin}' must be a bare http(s) origin (scheme://host[:port] or scheme://*.host[:port], no path)`,
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

/**
 * syndication: a name once peers exist; peer ids unique and well-formed;
 * a repo, a title and a `{id}` page URL template on every peer; locale
 * prefixes and value maps in shape.
 */
export function checkSyndication(cfg: { name: string | null; peers: readonly SyndicationPeer[] }): void {
  if (cfg.peers.length === 0) return;
  if (!cfg.name || !SYNDICATION_NAME.test(cfg.name)) {
    throw new Error(
      `syndication.name '${cfg.name ?? ''}' must be lowercase letters, digits and dashes (it names this wiki on its peers)`,
    );
  }
  const ids = new Set<string>();
  for (const peer of cfg.peers) {
    const at = `syndication.peers[${peer.id}]`;
    if (!SYNDICATION_NAME.test(peer.id)) {
      throw new Error(`syndication.peers: id '${peer.id}' must be lowercase letters, digits and dashes`);
    }
    if (ids.has(peer.id)) throw new Error(`syndication.peers: duplicate id '${peer.id}'`);
    ids.add(peer.id);
    if (!peer.title.trim()) throw new Error(`${at}.title must not be empty`);
    if (!peer.repo.trim() || /\s/.test(peer.repo)) throw new Error(`${at}.repo '${peer.repo}' is not a git URL`);
    const branchProblem = checkBranchName(peer.branch);
    if (branchProblem) throw new Error(`${at}.branch '${peer.branch}' ${branchProblem}`);
    if (peer.contentDir.startsWith('/') || peer.contentDir.split('/').some((seg) => seg === '..')) {
      throw new Error(`${at}.contentDir '${peer.contentDir}' must be a relative path inside the repository, without '..'`);
    }
    checkHttpUrl(`${at}.url`, peer.url);
    if (!peer.url.includes('{id}')) throw new Error(`${at}.url '${peer.url}' must contain {id} (the note id)`);
    for (const prefix of peer.locales) {
      if (prefix !== '' && !/^[\w-]+\/$/.test(prefix)) {
        throw new Error(`${at}.locales entry '${prefix}' must be '<segment>/' (word characters and dashes)`);
      }
    }
    for (const [field, values] of Object.entries(peer.map)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error(`${at}.map.${field} must map this wiki's values to the peer's (an object)`);
      }
      for (const [from, to] of Object.entries(values)) {
        if (to !== null && typeof to !== 'string') {
          throw new Error(`${at}.map.${field}.${from} must be a string or null (drop the value)`);
        }
      }
    }
  }
}
