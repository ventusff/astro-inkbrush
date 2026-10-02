/**
 * Share module — static snapshots of single notes, hosted by a snapshot
 * gateway and readable by whoever the share's visibility says: the holders
 * of a password, anyone holding the (unguessable) link, or everyone — a
 * public share is indexable and may live at a readable alias. The gateway
 * is a pluggable contract, not a bundled service: anything that implements
 * the small admin API (`PUT/PATCH/DELETE/GET /admin/s/<id>`, Bearer auth,
 * tar.gz body on PUT) works.
 *
 * The engine only ever talks outbound to that admin API (`share.gatewayUrl`
 * + Bearer SHARE_GATEWAY_TOKEN); a password is scrypt-hashed on this side,
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

import { englishOf, failure, type WikiFailure } from '../shared/errors.ts';
import { isShareVisibility, parseIdentity, type ShareIdentity } from '../shared/share-identity.ts';
import type {
  GoogleAuthState,
  ShareCreateRequest,
  ShareListResponse,
  SharePinRequest,
  ShareProgress,
  ShareRecord,
  ShareStreamEvent,
  ShareVisibility,
  ShareVisibilityRequest,
} from '../shared/types.ts';
import { wikiConfig } from './config.ts';
import { findUser as findIdentityUser, identityConfig } from './identity.ts';
import type { Ctx, RouteRegistrar } from './index.ts';
import { fail, failureBody, failureOf, type HttpError, json, ndjsonStream, readBody, refuse } from './index.ts';
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
    fail(ctx.res, 404, 'share-off');
    return null;
  }
  const conf = shareConf();
  if (!conf) {
    fail(ctx.res, 503, 'share-unconfigured');
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
 *  follow uploads regardless), and those written before visibility existed
 *  as password shares at their id address */
function readShares(): ShareRecord[] {
  return readJson<ShareRecord[]>(sharesFile(), []).map((record) => ({
    ...record,
    visibility: record.visibility ?? 'password',
    alias: record.alias ?? null,
    pinned: record.pinned ?? false,
    publishedAt: record.publishedAt ?? record.createdAt,
  }));
}

/** where recipients open the share: a public share at its alias, every
 *  other share at its id */
function shareUrl(conf: ShareConf, id: string, alias: string | null): string {
  return alias ? `${conf.publicBase}/${alias}/` : `${conf.publicBase}/s/${id}/`;
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
 *  is what the caller answers 502 with */
async function gatewayPreflight(conf: ShareConf): Promise<WikiFailure | null> {
  try {
    const ping = await gatewayFetch(conf, '/admin/s', {}, 5000);
    if (ping.status === 401) return failure('gateway-token');
    if (!ping.ok) return failure('gateway-status', { status: ping.status, detail: '' });
    return null;
  } catch (err) {
    return gatewayUnreachable(conf, err);
  }
}

function gatewayUnreachable(conf: ShareConf, err: unknown): WikiFailure {
  return failure('gateway-unreachable', { url: conf.gatewayUrl, detail: err instanceof Error ? err.message : String(err) });
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
 *  extract the page and its asset closure — indexable for a public share,
 *  noindex otherwise — fingerprint, tar. The caller removes the temp files */
async function packSnapshot(
  route: string,
  visibility: ShareVisibility,
  progress: (progress: ShareProgress) => void,
  signal: AbortSignal,
): Promise<Bundle> {
  const snapshot = await buildSnapshot(projectRoot(), route, progress, signal, { indexable: visibility === 'public' });
  const fingerprint = snapshotFingerprint(snapshot);
  const tgzPath = `${snapshot.dir}.tgz`;
  progress({ stage: 'packing', count: snapshot.files.length + 1 });
  // index.html at the tar root — the gateway extracts into site/ as-is
  await tar.c({ gzip: true, cwd: snapshot.dir, file: tgzPath, portable: true }, readdirSync(snapshot.dir));
  const size = statSync(tgzPath).size;
  if (size > BUNDLE_LIMIT) {
    rmSync(snapshot.dir, { recursive: true, force: true });
    rmSync(tgzPath, { force: true });
    throw refuse(413, 'snapshot-too-large', { size: Math.round(size / 1048576), limit: BUNDLE_LIMIT / 1048576 });
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

/** the gateway's refusal of a change, as the author reads it */
async function gatewayRefusal(res: Response): Promise<HttpError> {
  const text = (await res.text()).slice(0, 300);
  if (res.status === 409) return refuse(502, 'gateway-refused', { detail: text });
  return refuse(502, 'gateway-status', { status: res.status, detail: text });
}

/** PATCH what a share is — visibility, credential, alias — content untouched */
async function patchGateway(
  conf: ShareConf,
  id: string,
  patch: { visibility: ShareVisibility; passwordHash?: string; alias: string | null },
): Promise<void> {
  const res = await gatewayFetch(
    conf,
    `/admin/s/${id}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) },
    30_000,
  );
  if (res.status === 404) throw refuse(502, 'gateway-unknown-share');
  if (!res.ok) throw await gatewayRefusal(res);
}

/* ---------------- republish (follow + "publish this version") ---------------- */

/** one publish per share at a time: a click, the follower and a visibility
 *  change cannot overlap on one share */
async function withPublishing<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (publishing.has(id)) throw refuse(409, 'share-busy');
  publishing.add(id);
  try {
    return await work();
  } finally {
    publishing.delete(id);
  }
}

/** the share as it is stored right now — a caller that captured a record
 *  earlier (the follower's candidate list, a route before its preflight)
 *  publishes what the share has become, not what it was */
function activeShare(id: string): ShareRecord {
  const record = readShares().find((r) => r.id === id && isActive(r));
  if (!record) throw refuse(404, 'share-not-found');
  return record;
}

/**
 * Republish an active share from the note as it is now. The snapshot is
 * uploaded only when its bytes differ from the published version (or when
 * forced); either way the record's published version moves to now. A
 * gateway that no longer holds the share (404) is reported — the share
 * must be revoked and created again, the credentials cannot be recreated
 * here. The caller holds the share's publishing slot.
 */
async function republishHeld(
  conf: ShareConf,
  record: ShareRecord,
  progress: (progress: ShareProgress) => void,
  signal: AbortSignal,
  force = false,
): Promise<ShareRecord> {
  let bundle: Bundle | null = null;
  try {
    bundle = await packSnapshot(record.route, record.visibility, progress, signal);
    signal.throwIfAborted();
    const publishedAt = new Date().toISOString();
    if (!force && bundle.fingerprint === record.publishedHash) {
      progress({ stage: 'unchanged' });
    } else {
      progress({ stage: 'uploading' });
      const put = await uploadBundle(conf, record.id, bundle, { 'x-share-note': noteHeader(record.note) });
      if (put.status === 404) throw refuse(502, 'gateway-lost');
      if (!put.ok) throw await gatewayRefusal(put);
    }
    let current: ShareRecord | null = null;
    await updateShares((shares) => {
      const stored = shares.find((r) => r.id === record.id);
      if (!stored || stored.revokedAt) return;
      stored.publishedAt = publishedAt;
      stored.publishedHash = bundle!.fingerprint;
      current = stored;
    });
    if (!current) throw refuse(409, 'share-revoked-meanwhile');
    return current;
  } finally {
    discardBundle(bundle);
  }
}

/** republish by id, from the share as it is once the slot is ours; the
 *  follower passes `unlessPinned` — a share pinned meanwhile is left alone */
function republish(
  conf: ShareConf,
  id: string,
  progress: (progress: ShareProgress) => void,
  signal: AbortSignal,
  { unlessPinned = false } = {},
): Promise<ShareRecord> {
  return withPublishing(id, () => {
    const record = activeShare(id);
    if (unlessPinned && record.pinned) return Promise.resolve(record);
    return republishHeld(conf, record, progress, signal);
  });
}

/**
 * The gateway's word on what a share is, written over the local record —
 * for the moment a change may or may not have reached it (a timeout, a
 * failure after its answer). Best effort: a gateway that cannot be asked
 * leaves the record as it is.
 */
async function reconcile(conf: ShareConf, id: string): Promise<void> {
  const res = await gatewayFetch(conf, '/admin/s', {}, 5000);
  if (!res.ok) return;
  const rows = (await res.json()) as Array<{ id: string; visibility?: unknown; alias?: unknown; alive?: unknown }>;
  const row = rows.find((r) => r.id === id);
  if (!row || row.alive !== true || !isShareVisibility(row.visibility)) return;
  const visibility = row.visibility;
  const alias = typeof row.alias === 'string' ? row.alias : null;
  await updateShares((shares) => {
    const stored = shares.find((r) => r.id === id);
    if (!stored || stored.revokedAt) return;
    stored.visibility = visibility;
    stored.alias = alias;
    stored.url = shareUrl(conf, id, alias);
  });
}

/**
 * Move an active share to another visibility, credential or address; the
 * id address stays. Only entering `public` touches content: the page is
 * rebuilt without its robots meta and uploaded while the gateway still
 * keeps the share private, then the gateway's PATCH opens it — so a failed
 * PATCH leaves an indexable page that nothing indexes. Leaving public, or
 * moving between password and link, is the PATCH alone: nothing unpublished
 * reaches the gateway on the way to a tighter setting. A pinned share is
 * not made public, since that would publish the note as it is now. When
 * the PATCH's outcome is uncertain, the record takes the gateway's word.
 */
function changeVisibility(
  conf: ShareConf,
  id: string,
  identity: ShareIdentity,
  progress: (progress: ShareProgress) => void,
  signal: AbortSignal,
): Promise<ShareRecord> {
  return withPublishing(id, async () => {
    const record = activeShare(id);
    const alias = identity.visibility === 'public' ? identity.alias : null;
    const next: ShareRecord = { ...record, visibility: identity.visibility, alias, url: shareUrl(conf, id, alias) };
    const entersPublic = record.visibility !== 'public' && next.visibility === 'public';
    if (entersPublic && record.pinned) throw refuse(409, 'share-unpin-first');
    if (entersPublic) await republishHeld(conf, next, progress, signal, true);
    signal.throwIfAborted();
    progress({ stage: 'updating' });
    try {
      await patchGateway(conf, id, {
        visibility: next.visibility,
        ...(next.visibility === 'password' ? { passwordHash: await hashPassword(identity.password) } : {}),
        alias,
      });
      let current: ShareRecord | null = null;
      await updateShares((shares) => {
        const stored = shares.find((r) => r.id === id);
        if (!stored || stored.revokedAt) return;
        stored.visibility = next.visibility;
        stored.alias = next.alias;
        stored.url = next.url;
        current = stored;
      });
      if (!current) throw refuse(409, 'share-revoked-meanwhile');
      return current;
    } catch (err) {
      await reconcile(conf, id).catch(() => undefined);
      throw err;
    }
  });
}

const FOLLOWER_KEY = '__wikiShareFollower';

/**
 * The follower: every minute, active unpinned shares whose note changed
 * after the published version and has been quiet for
 * `share.followIdleMinutes` are republished, one at a time, by the process
 * on duty (./duty.ts). Starting it again replaces the running one (server
 * module reloads).
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
    publish: (record) =>
      republish(conf, record.id, () => undefined, new AbortController().signal, { unlessPinned: true }).then(() => undefined),
    describe: (record) => `${record.note} (${record.id})`,
    log,
  });
  globals[FOLLOWER_KEY] = stop;
  log(`shares follow their notes — republished ${conf.followIdleMinutes} min after the last change`);
}

/* ---------------- routes ---------------- */

/** a share stream's error event for whatever stopped it */
function errorEvent(err: unknown): ShareStreamEvent {
  const f = failureOf(err);
  return { kind: 'error', message: englishOf(f), ...f };
}

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
      const expiresDays = body.expiresDays ?? null;
      if (!note || !noteMeta(note)) return fail(res, 404, 'note-not-found');
      const route = noteUrl(note);
      const identity = parseIdentity(body);
      if ('code' in identity) return json(res, 400, failureBody(identity));
      if (expiresDays !== null && expiresDays !== 7 && expiresDays !== 30) {
        return fail(res, 400, 'bad-request', { detail: 'expiresDays must be 7, 30 or null' });
      }
      // one active share per note
      const existing = readShares().find((r) => r.note === note && isActive(r));
      if (existing) {
        return json(res, 409, { ...failureBody(failure('share-exists')), share: shareView(existing, user!.email) });
      }
      // reserve the note before any building starts; released in finally
      if (creating.has(note)) return fail(res, 409, 'share-creating');
      creating.add(note);
      try {
        // the gateway is checked before the (minutes-long) build
        const unreachable = await gatewayPreflight(conf);
        if (unreachable) return json(res, 502, failureBody(unreachable));

        const stream = ndjsonStream(res);
        const progress = (p: ShareProgress): void => {
          stream.write({ kind: 'progress', ...p } satisfies ShareStreamEvent);
        };
        // a creator who disconnects cancels the snapshot work
        const closed = new AbortController();
        res.on('close', () => closed.abort());
        let bundle: Bundle | null = null;
        try {
          bundle = await packSnapshot(route, identity.visibility, progress, closed.signal);
          // a disconnected creator stops before the gateway sees anything
          closed.signal.throwIfAborted();

          const id = mintId();
          const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
          progress({ stage: 'uploading' });
          const put = await uploadBundle(conf, id, bundle, {
            'x-share-visibility': identity.visibility,
            ...(identity.visibility === 'password' ? { 'x-share-password': await hashPassword(identity.password) } : {}),
            ...(identity.alias ? { 'x-share-alias': identity.alias } : {}),
            ...(expiresAt ? { 'x-share-expires': expiresAt } : {}),
            'x-share-note': noteHeader(note),
          });
          // a gateway from before visibilities reads a PUT without a password
          // header as an update of an unknown id
          if (put.status === 404 && identity.visibility !== 'password') throw refuse(502, 'gateway-outdated');
          if (!put.ok) throw await gatewayRefusal(put);

          const createdAt = new Date().toISOString();
          const record: ShareRecord = {
            id,
            note,
            route,
            url: shareUrl(conf, id, identity.alias),
            visibility: identity.visibility,
            alias: identity.alias,
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
            if (lostRace) throw refuse(409, 'share-exists');
          } catch (err) {
            await gatewayFetch(conf, `/admin/s/${id}`, { method: 'DELETE' }, 10_000).catch((cleanupErr: unknown) => {
              console.error(`[wiki share] could not delete orphaned gateway share ${id}:`, cleanupErr);
            });
            throw err;
          }
          // the creator can always revoke what they just created
          stream.write({ kind: 'result', ok: true, share: shareView(record, user!.email) } satisfies ShareStreamEvent);
        } catch (err) {
          stream.write(errorEvent(err));
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
      if (!note) return fail(ctx.res, 400, 'bad-request', { detail: 'missing note parameter' });
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
      if (!record) return fail(ctx.res, 404, 'share-not-found');
      if (!canManage(record, ctx.user!.email)) return fail(ctx.res, 403, 'share-not-yours', { action: 'publish' });
      if (publishing.has(record.id)) return fail(ctx.res, 409, 'share-busy');
      const unreachable = await gatewayPreflight(conf);
      if (unreachable) return json(ctx.res, 502, failureBody(unreachable));
      const stream = ndjsonStream(ctx.res);
      const closed = new AbortController();
      ctx.res.on('close', () => closed.abort());
      try {
        const current = await republish(
          conf,
          record.id,
          (p) => stream.write({ kind: 'progress', ...p } satisfies ShareStreamEvent),
          closed.signal,
        );
        stream.write({ kind: 'result', ok: true, share: shareView(current, ctx.user!.email) } satisfies ShareStreamEvent);
      } catch (err) {
        stream.write(errorEvent(err));
      }
      stream.close();
    },
    { auth: true },
  );

  on(
    'POST',
    '/share/:id/visibility',
    async (ctx) => {
      const conf = requireShare(ctx);
      if (!conf) return;
      const body = await readBody<ShareVisibilityRequest>(ctx.req);
      if (typeof body.visibility !== 'string') return fail(ctx.res, 400, 'bad-request', { detail: 'visibility is required' });
      const identity = parseIdentity(body);
      if ('code' in identity) return json(ctx.res, 400, failureBody(identity));
      const record = readShares().find((r) => r.id === ctx.params['id'] && isActive(r));
      if (!record) return fail(ctx.res, 404, 'share-not-found');
      if (!canManage(record, ctx.user!.email)) return fail(ctx.res, 403, 'share-not-yours', { action: 'change' });
      if (publishing.has(record.id)) return fail(ctx.res, 409, 'share-busy');
      const unreachable = await gatewayPreflight(conf);
      if (unreachable) return json(ctx.res, 502, failureBody(unreachable));
      const stream = ndjsonStream(ctx.res);
      const closed = new AbortController();
      ctx.res.on('close', () => closed.abort());
      try {
        const current = await changeVisibility(
          conf,
          record.id,
          identity,
          (p) => stream.write({ kind: 'progress', ...p } satisfies ShareStreamEvent),
          closed.signal,
        );
        stream.write({ kind: 'result', ok: true, share: shareView(current, ctx.user!.email) } satisfies ShareStreamEvent);
      } catch (err) {
        stream.write(errorEvent(err));
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
      if (typeof body.pinned !== 'boolean') return fail(ctx.res, 400, 'bad-request', { detail: 'pinned must be a boolean' });
      const record = readShares().find((r) => r.id === ctx.params['id'] && isActive(r));
      if (!record) return fail(ctx.res, 404, 'share-not-found');
      if (!canManage(record, ctx.user!.email)) return fail(ctx.res, 403, 'share-not-yours', { action: 'pin' });
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
      if (!record) return fail(ctx.res, 404, 'share-not-found');
      if (!canManage(record, ctx.user!.email)) return fail(ctx.res, 403, 'share-not-yours', { action: 'revoke' });
      try {
        const del = await gatewayFetch(conf, `/admin/s/${record.id}`, { method: 'DELETE' }, 10_000);
        // gateway 404 = already gone (expired/manually removed) — revoke anyway
        if (!del.ok && del.status !== 404) return fail(ctx.res, 502, 'gateway-status', { status: del.status, detail: '' });
      } catch (err) {
        return json(ctx.res, 502, failureBody(gatewayUnreachable(conf, err)));
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
