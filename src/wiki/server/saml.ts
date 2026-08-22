/**
 * Google Workspace SAML SSO — the SP side. The engine only plays Service
 * Provider: it never signs requests and needs no private key of its own; the
 * IdP cert (from `auth.googleSaml.certFile`) verifies assertion signatures.
 * Every response must answer a request this process issued (InResponseTo is
 * validated against an in-memory cache and consumed), so an unsolicited or
 * replayed response is refused.
 *
 * Config lives in inkbrush.config.ts → auth.googleSaml (env overridable:
 * WIKI_SAML_SSO_URL / WIKI_SAML_IDP_ENTITY_ID / WIKI_SAML_CERT_FILE /
 * WIKI_SAML_ALLOWED_DOMAIN / WIKI_BASE_URL). Routes are registered in
 * ./index.ts:
 *   GET  /api/wiki/auth/saml/login     → 302 to the IdP (SP-initiated)
 *   POST /api/wiki/auth/saml/callback  → ACS (never 500s — error redirects)
 *   GET  /api/wiki/auth/saml/metadata  → SP metadata XML
 */
import { readFileSync, statSync } from 'node:fs';

import { SAML, type Profile } from '@node-saml/node-saml';
import { ValidateInResponseTo } from '@node-saml/node-saml/lib/types';

import type { GoogleAuthState } from '../shared/types.ts';
import { wikiConfig } from './config.ts';

/* —— cert normalization: three shapes must be accepted ——
 * 1) full multi-line PEM  2) bare base64 body  3) a whole `base64 -w0 cert.pem` blob */

function pemBody(text: string): string | null {
  const m = text.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) return null;
  return m[1]!.replace(/\s+/g, '');
}

export function normalizeCert(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // shape 1: full PEM
  const direct = pemBody(text);
  if (direct) return direct;
  const compact = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  // shape 3: whole-file base64 (decodes into a PEM)
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    const inner = pemBody(decoded);
    if (inner) return inner;
  } catch {
    /* fallthrough */
  }
  // shape 2: bare base64 body
  return compact;
}

function samlConf(): ReturnType<typeof wikiConfig>['auth']['googleSaml'] {
  return wikiConfig().auth.googleSaml;
}

/** read the IdP cert; unreadable = silently unconfigured (the mount may be
 *  an empty directory / the file not delivered yet) */
function loadIdpCert(): string | null {
  const conf = samlConf();
  if (conf === false || !conf.certFile) return null;
  try {
    if (!statSync(conf.certFile).isFile()) return null;
    return normalizeCert(readFileSync(conf.certFile, 'utf8'));
  } catch {
    return null;
  }
}

export function spEntityId(): string {
  const conf = samlConf();
  return conf === false ? '' : `${conf.baseUrl}/api/wiki/auth/saml/metadata`;
}

export function acsUrl(): string {
  const conf = samlConf();
  return conf === false ? '' : `${conf.baseUrl}/api/wiki/auth/saml/callback`;
}

export interface SamlEnv {
  saml: SAML;
  configured: boolean;
}

let ready: SamlEnv | null = null;

/**
 * The SAML SP. One configured instance is kept for the process: its
 * in-memory request-id cache is what ties a response to the request this
 * process issued. With configured=false the instance is only good for
 * generating SP metadata (a placeholder cert — SP metadata carries no IdP
 * information) and is rebuilt on each call, so a certificate delivered
 * later is picked up.
 */
export function buildSaml(): SamlEnv {
  if (ready) return ready;
  const conf = samlConf();
  if (conf === false) throw new Error('googleSaml auth is disabled (inkbrush.config.ts → auth.googleSaml)');
  const idpCert = loadIdpCert();
  const configured = Boolean(idpCert && conf.entryPoint && conf.idpEntityId && conf.baseUrl);
  const saml = new SAML({
    callbackUrl: acsUrl(),
    entryPoint: conf.entryPoint || 'https://accounts.google.com/o/saml2/idp',
    issuer: spEntityId(),
    idpCert: idpCert ?? 'MIIB-placeholder-not-configured',
    ...(conf.idpEntityId ? { idpIssuer: conf.idpEntityId } : {}),
    audience: spEntityId(),
    // Google signs only the assertion by default — don't demand a signed response
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5000,
    // every response must answer a request this process issued, once
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });
  const env = { saml, configured };
  if (configured) ready = env;
  return env;
}

/** off = disabled in inkbrush.config.ts · ready = usable · unconfigured =
 *  enabled but entryPoint / idpEntityId / cert / baseUrl incomplete */
export function googleSamlState(): GoogleAuthState {
  if (samlConf() === false) return 'off';
  return buildSaml().configured ? 'ready' : 'unconfigured';
}

/** server-enforced email domain/address allowlist — the same policy as
 *  Google OAuth: an empty allowedDomains admits nobody (fail-closed;
 *  deployments must list their domains), ['*'] admits every asserted email */
export function samlEmailAllowed(email: string): boolean {
  const conf = samlConf();
  const rules = conf === false ? [] : conf.allowedDomains.map((s) => s.toLowerCase());
  if (rules.includes('*')) return true; // explicit allow-all
  if (rules.length === 0) return false; // no list configured → deny (fail-closed)
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1] ?? '';
  return rules.some((rule) => rule === lower || rule === domain);
}

/** display name from assertion attributes (firstName/lastName, displayName
 *  and friends), falling back to the email prefix */
export function displayNameFromProfile(profile: Profile, email: string): string {
  const attr = (key: string): string | null => {
    const v = profile[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
    return null;
  };
  const first = attr('firstName') ?? attr('givenName') ?? attr('first_name');
  const last = attr('lastName') ?? attr('surname') ?? attr('sn') ?? attr('last_name');
  if (first || last) return [first, last].filter(Boolean).join(' ');
  const display = attr('displayName') ?? attr('name') ?? attr('cn');
  if (display) return display;
  return email.split('@')[0] ?? email;
}
