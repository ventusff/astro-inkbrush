/**
 * Share module — password-gated public snapshots of single notes, hosted by
 * a static-snapshot gateway. The gateway is a pluggable contract, not a
 * bundled service: anything that implements the small admin API
 * (`PUT/DELETE/GET /admin/s/<id>`, Bearer auth, tar.gz body on PUT) works.
 *
 * The engine only ever talks outbound to that admin API (`share.gatewayUrl`
 * + Bearer SHARE_GATEWAY_TOKEN); the password is scrypt-hashed on this side,
 * so the gateway never sees the plaintext. The snapshotted route is the
 * note's own route by the site's URL rule (`inkbrush({ markdown: { urlFor } })`,
 * default `/<id>/`), so a share record always names the page it serves.
 * Feature off (config share:false / omitted) ⇒ routes 404 and the client
 * button never mounts.
 *
 * A share follows its note: once the note has been quiet for
 * `share.followIdleMinutes` after a change, the snapshot is rebuilt and —
 * when its bytes differ from the published version — PUT to the same id
 * without a password header (the gateway keeps the credentials). "Publish
 * this version" does the same on demand; a pinned share never follows.
 *
 * POST /share and POST /share/:id/publish are NDJSON streams: the
 * underlying `astro build` can take minutes cold, so progress lines flow
 * while it runs.
 */
import { randomBytes, scrypt } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

import * as tar from 'tar';

import type {
  GoogleAuthState,
  ShareCreateRequest,
  ShareListResponse,
  SharePinRequest,
  ShareRecord,
  ShareStreamEvent,
} from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { findUser as findIdentityUser, identityConfig } from './identity.ts';
import type { Ctx, RouteRegistrar } from './index.ts';
import { fail, json, ndjsonStream, readBody } from './index.ts';
import { followDue, snapshotFingerprint, startShareFollower } from './share-follow.ts';
import { noteUrl } from './site.ts';
import { buildSnapshot, latestMtime } from './snapshot.ts';
import { noteDir, noteMeta } from './source.ts';
import { projectRoot, readJson, wikiDataDir, withLock, writeJson } from './store.ts';

/** a snapshot bundle above this size is refused before upload */
const BUNDLE_LIMIT = 256 * 1024 * 1024;

/** notes whose share is being created right now — an in-process reservation
 *  taken before the build, so two concurrent creates cannot build and
 *  upload the same note twice (the second request answers 409 immediately) */
const creating = new Set<string>();

/** shares being republished right now (a click and the follower cannot
 *  overlap on one share) */
const publishing = new Set<string>();

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
  followIdleMinutes: number;
}

function shareConf(): ShareConf | null {
  const share = wikiConfig().share;
  if (share === false) return null;
  const token = process.env['SHARE_GATEWAY_TOKEN'] ?? '';
  if (!share.gatewayUrl || !share.publicBase || !token) return null;
  return {
    gatewayUrl: share.gatewayUrl,
    publicBase: share.publicBase,
    token,
    followIdleMinutes: share.followIdleMinutes,
  };
}

/** feature gate shared by all routes: off → 404, incomplete → 503, else conf */
function requireShare(ctx: Ctx): ShareConf | null {
  const share = wikiConfig().share;
  if (share === false) {
    fail(ctx.res, 404, 'Share is not configured (inkbrush.config.ts → share)');
    return null;
  }
  const conf = shareConf();
  if (!conf) {
    fail(
      ctx.res,
      503,
      'Share is enabled but gatewayUrl / publicBase / SHARE_GATEWAY_TOKEN is missing',
    );
    return null;
  }
  return conf;
}

/* ---------------- persistence (.wiki/data/shares.json) ---------------- */

function sharesFile(): string {
  return wikiDataDir('shares.json');
}

/** stored records; records written before the follow fields existed read
 *  as unpinned, published at creation, with no fingerprint (the first
 *  follow uploads regardless) */
function readShares(): ShareRecord[] {
  return readJson<ShareRecord[]>(sharesFile(), []).map((record) => ({
    ...record,
    pinned: record.pinned ?? false,
    publishedAt: record.publishedAt ?? record.createdAt,
  }));
}

/** read-modify-write of the share list under its lock */
function updateShares(update: (shares: ShareRecord[]) => void): Promise<void> {
  return withLock(sharesFile(), () => {
    const shares = readShares();
    update(shares);
    writeJson(sharesFile(), shares);
  });
}

function isActive(record: ShareRecord): boolean {
  if (record.revokedAt) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) return false;
  return true;
}

/** newest change (ms) under the note's source directory; null when the
 *  note has no source any more */
function noteChangedAt(note: string): number | null {
  const dir = noteDir(note);
  if (!dir || !existsSync(dir)) return null;
  return latestMtime(dir);
}

/** the requester may manage this share: they created it, or they hold the
 *  admin role while the identity registry is on */
function canManage(record: ShareRecord, email: string): boolean {
  if (record.createdBy === email) return true;
  const identity = identityConfig();
  return identity !== null && findIdentityUser(email)?.role === identity.adminRole;
}

/** the record as the API returns it: without its creator's email, with the
 *  requester's permission and the note's change state against the
 *  published version */
function shareView(record: ShareRecord, email: string): ShareRecord {
  const { createdBy: _createdBy, publishedHash: _hash, ...rest } = record;
  const changed = noteChangedAt(record.note);
  const stale = changed !== null && changed > Date.parse(record.publishedAt);
  return {
    ...rest,
    canRevoke: canManage(record, email),
    stale,
    noteChangedAt: stale ? new Date(changed).toISOString() : null,
  };
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

/** gateway password format: `scrypt$N$r$p$<salt-b64url>$<hash-b64url>` —
 *  derived off the event loop (async scrypt) */
async function hashPassword(password: string): Promise<string> {
  const N = 2 ** 15;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    // maxmem must exceed 128*N*r bytes — default 32 MiB throws at N=2^15
    scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
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

/** the gateway must answer before a (minutes-long) build starts; a failure
 *  is the message the caller answers 502 with */
async function gatewayPreflight(conf: ShareConf): Promise<string | null> {
  try {
    const ping = await gatewayFetch(conf, '/admin/s', {}, 5000);
    if (ping.status === 401) return 'Share gateway rejected SHARE_GATEWAY_TOKEN';
    if (!ping.ok) return `Share gateway error (HTTP ${ping.status})`;
    return null;
  } catch (err) {
    return `Share gateway unreachable (${conf.gatewayUrl}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** header values are latin1 — a CJK note id travels percent-encoded */
function noteHeader(note: string): string {
  return /^[\x20-\x7e]*$/.test(note) ? note : encodeURIComponent(note);
}

interface Bundle {
  snapDir: string;
  tgzPath: string;
  size: number;
  fingerprint: string;
}

/** the note's snapshot, packed for upload: build (cached while fresh),
 *  extract the page and its asset closure, fingerprint, tar. The caller
 *  removes the temp files */
async function packSnapshot(
  route: string,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<Bundle> {
  const snapshot = await buildSnapshot(projectRoot(), route, progress, signal);
  const fingerprint = snapshotFingerprint(snapshot);
  const tgzPath = `${snapshot.dir}.tgz`;
  progress(`Packing snapshot (${snapshot.files.length + 1} files)…`);
  // index.html at the tar root — the gateway extracts into site/ as-is
  await tar.c({ gzip: true, cwd: snapshot.dir, file: tgzPath, portable: true }, readdirSync(snapshot.dir));
  const size = statSync(tgzPath).size;
  if (size > BUNDLE_LIMIT) {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(tgzPath, { force: true });
    throw new Error(`snapshot bundle is ${Math.round(size / 1048576)} MiB, above the ${BUNDLE_LIMIT / 1048576} MiB limit`);
  }
  return { snapDir: snapshot.dir, tgzPath, size, fingerprint };
}

function discardBundle(bundle: Bundle | null): void {
  if (!bundle) return;
  rmSync(bundle.snapDir, { recursive: true, force: true });
  rmSync(bundle.tgzPath, { force: true });
}

/** PUT the bundle to the gateway — streamed from disk, never held in memory */
async function uploadBundle(
  conf: ShareConf,
  id: string,
  bundle: Bundle,
  headers: Record<string, string>,
): Promise<Response> {
  return gatewayFetch(
    conf,
    `/admin/s/${id}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(bundle.size),
        ...headers,
      },
      body: Readable.toWeb(createReadStream(bundle.tgzPath)) as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit,
    600_000,
  );
}

/* ---------------- republish (follow + "publish this version") ---------------- */

/**
 * Republish an active share from the note as it is now. The snapshot is
 * uploaded only when its bytes differ from the published version; either
 * way the record's published version moves to now. A gateway that no
 * longer holds the share (404) is reported — the share must be revoked and
 * created again, the credentials cannot be recreated here.
 */
async function republish(
  conf: ShareConf,
  record: ShareRecord,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<ShareRecord> {
  if (publishing.has(record.id)) throw new Error('This share is being published right now — wait for it to finish');
  publishing.add(record.id);
  let bundle: Bundle | null = null;
  try {
    bundle = await packSnapshot(record.route, progress, signal);
    signal.throwIfAborted();
    const publishedAt = new Date().toISOString();
    if (bundle.fingerprint === record.publishedHash) {
      progress('The published snapshot already matches — nothing to upload');
    } else {
      progress('Uploading to the share gateway…');
      const put = await uploadBundle(conf, record.id, bundle, { 'x-share-note': noteHeader(record.note) });
      if (put.status === 404) {
        throw new Error('The share gateway no longer holds this share — revoke it and share the note again');
      }
      if (!put.ok) {
        throw new Error(`gateway update failed (HTTP ${put.status}): ${(await put.text()).slice(0, 300)}`);
      }
    }
    let current: ShareRecord | null = null;
    await updateShares((shares) => {
      const stored = shares.find((r) => r.id === record.id);
      if (!stored || stored.revokedAt) return;
      stored.publishedAt = publishedAt;
      stored.publishedHash = bundle!.fingerprint;
      current = stored;
    });
    if (!current) throw new Error('The share was revoked while it was being published');
    return current;
  } finally {
    discardBundle(bundle);
    publishing.delete(record.id);
  }
}

const FOLLOWER_KEY = '__wikiShareFollower';

/**
 * The follower: every minute, active unpinned shares whose note changed
 * after the published version and has been quiet for
 * `share.followIdleMinutes` are republished, one at a time. Starting it
 * again replaces the running one (server module reloads).
 */
export function startShareFollowing(): void {
  const globals = globalThis as Record<string, unknown>;
  (globals[FOLLOWER_KEY] as (() => void) | undefined)?.();
  const conf = shareConf();
  if (!conf || conf.followIdleMinutes <= 0) return;
  const idleMs = conf.followIdleMinutes * 60_000;
  const log = (message: string): void => console.log(`[wiki share] ${message}`);
  const stop = startShareFollower<ShareRecord>({
    due: () =>
      readShares().filter(
        (record) =>
          isActive(record) &&
          !publishing.has(record.id) &&
          followDue(
            { pinned: record.pinned, publishedAt: record.publishedAt, noteChangedAt: noteChangedAt(record.note) },
            Date.now(),
            idleMs,
          ),
      ),
    publish: (record) => republish(conf, record, () => undefined, new AbortController().signal).then(() => undefined),
    describe: (record) => `${record.note} (${record.id})`,
    log,
  });
  globals[FOLLOWER_KEY] = stop;
  log(`shares follow their notes — republished ${conf.followIdleMinutes} min after the last change`);
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
      const password = typeof body.password === 'string' ? body.password : '';
      const expiresDays = body.expiresDays ?? null;
      if (!note || !noteMeta(note)) return fail(res, 404, 'Note not found');
      const route = noteUrl(note);
      if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters');
      if (expiresDays !== null && expiresDays !== 7 && expiresDays !== 30) {
        return fail(res, 400, 'expiresDays must be 7, 30 or null');
      }
      // one active share per note
      const existing = readShares().find((r) => r.note === note && isActive(r));
      if (existing) {
        return json(res, 409, {
          error: 'This note already has an active share link — revoke it first',
          share: shareView(existing, user!.email),
        });
      }
      // reserve the note before any building starts; released in finally
      if (creating.has(note)) {
        return fail(res, 409, 'A share for this note is already being created — wait for it to finish');
      }
      creating.add(note);
      try {
        // the gateway is checked before the (minutes-long) build
        const unreachable = await gatewayPreflight(conf);
        if (unreachable) return fail(res, 502, unreachable);

        const stream = ndjsonStream(res);
        const progress = (message: string): void => {
          stream.write({ kind: 'progress', message } satisfies ShareStreamEvent);
        };
        // a creator who disconnects cancels the snapshot work
        const closed = new AbortController();
        res.on('close', () => closed.abort());
        let bundle: Bundle | null = null;
        try {
          bundle = await packSnapshot(route, progress, closed.signal);
          // a disconnected creator stops before the gateway sees anything
          closed.signal.throwIfAborted();

          const id = mintId();
          const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
          progress('Uploading to the share gateway…');
          const put = await uploadBundle(conf, id, bundle, {
            'x-share-password': await hashPassword(password),
            ...(expiresAt ? { 'x-share-expires': expiresAt } : {}),
            'x-share-note': noteHeader(note),
          });
          if (!put.ok) {
            throw new Error(`gateway upload failed (HTTP ${put.status}): ${(await put.text()).slice(0, 300)}`);
          }

          const createdAt = new Date().toISOString();
          const record: ShareRecord = {
            id,
            note,
            route,
            url: `${conf.publicBase}/s/${id}/`,
            createdBy: user!.email,
            createdAt,
            expiresAt,
            revokedAt: null,
            pinned: false,
            publishedAt: createdAt,
            publishedHash: bundle.fingerprint,
          };
          // the local record must persist, and stay the note's only active one;
          // otherwise the uploaded share is deleted again (compensation) so the
          // gateway never serves a share this server has no record of
          let lostRace = false;
          try {
            await updateShares((shares) => {
              if (shares.some((r) => r.note === note && isActive(r))) {
                lostRace = true;
                return;
              }
              shares.push(record);
            });
            if (lostRace) throw new Error('This note already has an active share link — revoke it first');
          } catch (err) {
            await gatewayFetch(conf, `/admin/s/${id}`, { method: 'DELETE' }, 10_000).catch((cleanupErr: unknown) => {
              console.error(`[wiki share] could not delete orphaned gateway share ${id}:`, cleanupErr);
            });
            throw err;
          }
          // the creator can always revoke what they just created
          stream.write({ kind: 'result', ok: true, share: shareView(record, user!.email) } satisfies ShareStreamEvent);
        } catch (err) {
          stream.write({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          } satisfies ShareStreamEvent);
        } finally {
          discardBundle(bundle);
        }
        stream.close();
      } finally {
        creating.delete(note);
      }
    },
    { auth: true },
  );

  on(
    'GET',
    '/share',
    (ctx) => {
      const conf = requireShare(ctx);
      if (!conf) return;
      const note = ctx.query.get('note');
      if (!note) return fail(ctx.res, 400, 'missing note parameter');
      const shares = readShares()
        .filter((r) => isActive(r) && r.note === note)
        .map((r) => shareView(r, ctx.user!.email));
      json(ctx.res, 200, { shares, followIdleMinutes: conf.followIdleMinutes } satisfies ShareListResponse);
    },
    { auth: true },
  );

  on(
    'POST',
    '/share/:id/publish',
    async (ctx) => {
      const conf = requireShare(ctx);
      if (!conf) return;
      const record = readShares().find((r) => r.id === ctx.params['id'] && isActive(r));
      if (!record) return fail(ctx.res, 404, 'Share not found');
      if (!canManage(record, ctx.user!.email)) {
        return fail(ctx.res, 403, 'Only the share creator (or an admin) can publish it');
      }
      if (publishing.has(record.id)) {
        return fail(ctx.res, 409, 'This share is being published right now — wait for it to finish');
      }
      const unreachable = await gatewayPreflight(conf);
      if (unreachable) return fail(ctx.res, 502, unreachable);
      const stream = ndjsonStream(ctx.res);
      const closed = new AbortController();
      ctx.res.on('close', () => closed.abort());
      try {
        const current = await republish(
          conf,
          record,
          (message) => stream.write({ kind: 'progress', message } satisfies ShareStreamEvent),
          closed.signal,
        );
        stream.write({ kind: 'result', ok: true, share: shareView(current, ctx.user!.email) } satisfies ShareStreamEvent);
      } catch (err) {
        stream.write({ kind: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ShareStreamEvent);
      }
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/share/:id/pin',
    async (ctx) => {
      if (!requireShare(ctx)) return;
      const body = await readBody<SharePinRequest>(ctx.req);
      if (typeof body.pinned !== 'boolean') return fail(ctx.res, 400, 'pinned must be a boolean');
      const record = readShares().find((r) => r.id === ctx.params['id'] && isActive(r));
      if (!record) return fail(ctx.res, 404, 'Share not found');
      if (!canManage(record, ctx.user!.email)) {
        return fail(ctx.res, 403, 'Only the share creator (or an admin) can pin it');
      }
      let current: ShareRecord = record;
      await updateShares((shares) => {
        const stored = shares.find((r) => r.id === record.id);
        if (!stored) return;
        stored.pinned = body.pinned;
        current = stored;
      });
      json(ctx.res, 200, { share: shareView(current, ctx.user!.email) });
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
      if (!canManage(record, ctx.user!.email)) {
        return fail(ctx.res, 403, 'Only the share creator (or an admin) can revoke it');
      }
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
      await updateShares((shares) => {
        const current = shares.find((r) => r.id === record.id);
        if (current && !current.revokedAt) current.revokedAt = new Date().toISOString();
      });
      json(ctx.res, 200, { ok: true });
    },
    { auth: true },
  );
}
