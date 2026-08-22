/**
 * Share module — password-gated public snapshots of single notes, hosted by
 * a static-snapshot gateway. The gateway is a pluggable contract, not a
 * bundled service: anything that implements the small admin API
 * (`PUT/DELETE/GET /admin/s/<id>`, Bearer auth, tar.gz body on PUT) works.
 *
 * The engine only ever talks OUTBOUND to that admin API (`share.gatewayUrl` +
 * Bearer SHARE_GATEWAY_TOKEN); the password is scrypt-hashed on this side, so
 * the gateway never sees the plaintext. Feature off (config share:false /
 * omitted) ⇒ routes 404 and the client button never mounts — zero behaviour
 * change by default.
 *
 * POST /share is an NDJSON stream: the underlying `astro build` can take
 * minutes cold, so progress lines flow while it runs (same streaming idiom as
 * the claude bridge).
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as tar from 'tar';

import type {
  GoogleAuthState,
  ShareCreateRequest,
  ShareListResponse,
  ShareRecord,
  ShareStreamEvent,
} from '../shared/types';
import { wikiConfig } from './config';
import type { Ctx, RouteRegistrar } from './index';
import { fail, json, ndjsonStream, readBody } from './index';
import { buildSnapshot } from './snapshot';
import { noteMeta } from './source';
import { projectRoot, readJson, wikiDataDir } from './store';

/* ---------------- availability ---------------- */

/** off = share:false/omitted in inkbrush.config.ts (routes 404, no button) ·
 *  ready = usable · unconfigured = enabled but urls/token missing */
export function shareState(): GoogleAuthState {
  const share = wikiConfig().share;
  if (share === false) return 'off';
  const token = process.env['SHARE_GATEWAY_TOKEN'] ?? '';
  return share.gatewayUrl && share.publicBase && token ? 'ready' : 'unconfigured';
}

interface ShareConf {
  gatewayUrl: string;
  publicBase: string;
  token: string;
}

/** feature gate shared by all routes: off → 404, incomplete → 503, else conf */
function requireShare(ctx: Ctx): ShareConf | null {
  const share = wikiConfig().share;
  if (share === false) {
    fail(ctx.res, 404, 'Share is not configured (inkbrush.config.ts → share)');
    return null;
  }
  const token = process.env['SHARE_GATEWAY_TOKEN'] ?? '';
  if (!share.gatewayUrl || !share.publicBase || !token) {
    fail(
      ctx.res,
      503,
      'Share is enabled but gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN is missing',
    );
    return null;
  }
  return { gatewayUrl: share.gatewayUrl, publicBase: share.publicBase, token };
}

/* ---------------- persistence (.wiki/data/shares.json) ---------------- */

function sharesFile(): string {
  return wikiDataDir('shares.json');
}

function readShares(): ShareRecord[] {
  return readJson<ShareRecord[]>(sharesFile(), []);
}

/** atomic full overwrite (tmp+rename, same idiom as identity users.json) */
function writeShares(shares: ShareRecord[]): void {
  const file = sharesFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(shares, null, 2));
  renameSync(tmp, file);
}

function isActive(record: ShareRecord): boolean {
  if (record.revokedAt) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) return false;
  return true;
}

/* ---------------- id + password hashing ---------------- */

// base58 — no 0/O/I/l, so recipients can read the id (and password) aloud
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 10-char base58 id via rejection sampling (no modulo bias; gateways
 *  typically validate ^[base58]{8,24}$) */
function mintId(length = 10): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(32)) {
      if (byte < 232 /* 58*4 — reject the biased tail */ && out.length < length) {
        out += BASE58[byte % 58]!;
      }
    }
  }
  return out;
}

/** gateway password format: `scrypt$N$r$p$<salt-b64url>$<hash-b64url>` */
function hashPassword(password: string): string {
  const N = 2 ** 15;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  // maxmem must exceed 128*N*r bytes — default 32 MiB throws at N=2^15
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/* ---------------- gateway client ---------------- */

async function gatewayFetch(
  conf: ShareConf,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`${conf.gatewayUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${conf.token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/* ---------------- validation ---------------- */

/** the client reports location.pathname; accept only clean site-internal paths */
function cleanRoute(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const route = raw.trim();
  if (!/^\/[A-Za-z0-9\-._/]*$/.test(route)) return null;
  if (route.includes('..') || route.includes('//')) return null;
  return route;
}

/* ---------------- routes ---------------- */

export function registerShareRoutes(on: RouteRegistrar): void {
  on(
    'POST',
    '/share',
    async (ctx) => {
      const { req, res, user } = ctx;
      const conf = requireShare(ctx);
      if (!conf) return;
      const body = await readBody<ShareCreateRequest>(req);
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      const route = cleanRoute(body.route);
      const password = typeof body.password === 'string' ? body.password : '';
      const expiresDays = body.expiresDays ?? null;
      if (!note || !noteMeta(note)) return fail(res, 404, 'Note not found');
      if (!route) return fail(res, 400, 'route must be a clean site-internal path');
      if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters');
      if (expiresDays !== null && expiresDays !== 7 && expiresDays !== 30) {
        return fail(res, 400, 'expiresDays must be 7, 30 or null');
      }

      // pre-flight the gateway BEFORE the (minutes-long) build, so an
      // unreachable gateway is an honest 502 instead of a wasted build
      try {
        const ping = await gatewayFetch(conf, '/admin/s', {}, 5000);
        if (ping.status === 401) {
          return fail(res, 502, 'Share gateway rejected SHARE_GATEWAY_TOKEN');
        }
        if (!ping.ok) return fail(res, 502, `Share gateway error (HTTP ${ping.status})`);
      } catch (err) {
        return fail(
          res,
          502,
          `Share gateway unreachable (${conf.gatewayUrl}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const stream = ndjsonStream(res);
      const progress = (message: string): void => {
        stream.write({ kind: 'progress', message } satisfies ShareStreamEvent);
      };
      let snapDir: string | null = null;
      let tgzPath: string | null = null;
      try {
        const snapshot = await buildSnapshot(projectRoot(), route, progress);
        snapDir = snapshot.dir;
        tgzPath = `${snapshot.dir}.tgz`;
        progress(`Packing snapshot (${snapshot.files.length + 1} files)…`);
        // index.html at the tar ROOT — the gateway extracts into site/ as-is
        await tar.c({ gzip: true, cwd: snapshot.dir, file: tgzPath, portable: true }, readdirSync(snapshot.dir));

        const id = mintId();
        const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
        progress('Uploading to the share gateway…');
        const put = await gatewayFetch(
          conf,
          `/admin/s/${id}`,
          {
            method: 'PUT',
            headers: {
              'content-type': 'application/gzip',
              'x-share-password': hashPassword(password),
              ...(expiresAt ? { 'x-share-expires': expiresAt } : {}),
              // header values must be latin1 — encode CJK note ids
              'x-share-note': /^[\x20-\x7e]*$/.test(note) ? note : encodeURIComponent(note),
            },
            body: new Uint8Array(readFileSync(tgzPath)),
          },
          120_000,
        );
        if (!put.ok) {
          throw new Error(`gateway upload failed (HTTP ${put.status}): ${(await put.text()).slice(0, 300)}`);
        }

        const record: ShareRecord = {
          id,
          note,
          route,
          url: `${conf.publicBase}/s/${id}/`,
          createdBy: user!.email,
          createdAt: new Date().toISOString(),
          expiresAt,
          revokedAt: null,
        };
        writeShares([...readShares(), record]);
        stream.write({ kind: 'result', ok: true, share: record } satisfies ShareStreamEvent);
      } catch (err) {
        stream.write({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies ShareStreamEvent);
      } finally {
        if (snapDir) rmSync(snapDir, { recursive: true, force: true });
        if (tgzPath) rmSync(tgzPath, { force: true });
      }
      stream.close();
    },
    { auth: true },
  );

  on(
    'GET',
    '/share',
    (ctx) => {
      if (!requireShare(ctx)) return;
      const note = ctx.query.get('note');
      const shares = readShares().filter((r) => isActive(r) && (!note || r.note === note));
      json(ctx.res, 200, { shares } satisfies ShareListResponse);
    },
    { auth: true },
  );

  on(
    'DELETE',
    '/share/:id',
    async (ctx) => {
      const conf = requireShare(ctx);
      if (!conf) return;
      const record = readShares().find((r) => r.id === ctx.params['id'] && !r.revokedAt);
      if (!record) return fail(ctx.res, 404, 'Share not found');
      try {
        const del = await gatewayFetch(conf, `/admin/s/${record.id}`, { method: 'DELETE' }, 10_000);
        // gateway 404 = already gone (expired/manually removed) — revoke anyway
        if (!del.ok && del.status !== 404) {
          return fail(ctx.res, 502, `gateway revoke failed (HTTP ${del.status})`);
        }
      } catch (err) {
        return fail(
          ctx.res,
          502,
          `Share gateway unreachable (${conf.gatewayUrl}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // re-read before persisting the revoke: the gateway call above can take
      // up to 10s, during which another request may have written new shares —
      // writing back the pre-call snapshot would silently erase them (TOCTOU)
      const shares = readShares();
      const current = shares.find((r) => r.id === record.id);
      if (current && !current.revokedAt) {
        current.revokedAt = new Date().toISOString();
        writeShares(shares);
      }
      json(ctx.res, 200, { ok: true });
    },
    { auth: true },
  );
}
