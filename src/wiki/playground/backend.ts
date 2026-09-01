/**
 * The browser-local backend: the same /api/wiki surface the editor already
 * speaks, served as a WikiTransport from the page's own source, the index
 * manifest and the visitor's IndexedDB — no server, no network, nothing
 * leaves the browser.
 *
 * Implemented: me / logout / meta / notes / block GET+PUT / render /
 * revisions / revert. Everything else (claude, comments, share, inbox,
 * identity admin) answers 404 — /me declares ai:'off' and share:'off', so
 * the client never mounts those affordances here.
 *
 * PUT keeps the dev server's save contract: optimistic lock on the slice
 * hash, then the whole reconstructed source must pass the same validation
 * the save gate runs (lib/render-pipeline.ts validateNoteSource) before the
 * override persists. The validator, the content guard and the site's plugin
 * graph load on the first save, not before.
 */
import type { ContentGuardOptions } from '../../lib/content-guard.ts';
import type { SitePluginSet } from '../../lib/render-pipeline.ts';
import type { WikiNoteInfo } from '../../lib/wikilink-core.ts';
import { ApiError, type RequestOptions, type WikiTransport } from '../client/api';
import type { MeResponse, NoteMeta, RevisionRecord, WikiUser } from '../shared/types';
import type { NoteOverlay } from './overlay';
import type { PlaygroundRenderer } from './render';
import { addRevision, putOverride, revisionsFor, type LocalRevision } from './store';

export interface ManifestLocale {
  code: string;
  prefix: string;
  label: string;
}

/** one row of the index: a note's identity — what wikilink resolution and
 *  the note list need; sources travel with their pages */
export type ManifestNote = WikiNoteInfo;

/** the index manifest: every note's identity plus the locale table */
export interface PlaygroundManifest {
  locales: ManifestLocale[];
  notes: ManifestNote[];
}

/** the note a page carries: its id (the page's <meta name="inkbrush-note">)
 *  and its repo-relative source path (the page's source island) */
export interface PlaygroundNote {
  id: string;
  /** repo-relative source path (shown in the editor head, vfile path) */
  file: string;
  mdx: boolean;
}

/** the site's save-gate inputs, requested on the first save */
export interface ValidationInputs {
  site: SitePluginSet;
  guard?: ContentGuardOptions | undefined;
}

export interface LocalBackendOptions {
  manifest: Promise<PlaygroundManifest>;
  /** the page's note and its overlay (one note per page) */
  note: PlaygroundNote;
  overlay: NoteOverlay;
  renderer: PlaygroundRenderer;
  guest: WikiUser;
  inputs: () => Promise<ValidationInputs>;
}

const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function sliceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function localeOfId(id: string, locales: ManifestLocale[]): string {
  for (const l of locales) {
    if (l.prefix !== '' && (id === l.prefix.replace(/\/$/, '') || id.startsWith(l.prefix))) return l.code;
  }
  return locales.find((l) => l.prefix === '')?.code ?? 'en';
}

function metaOf(note: PlaygroundNote, manifest: PlaygroundManifest): NoteMeta {
  const lang = localeOfId(note.id, manifest.locales);
  const baseId = manifest.locales
    .filter((l) => l.prefix !== '')
    .reduce((id, l) => (id.startsWith(l.prefix) ? id.slice(l.prefix.length) : id), note.id);
  const exists = new Set(manifest.notes.map((n) => n.id));
  return {
    id: note.id,
    file: note.file,
    title: manifest.notes.find((n) => n.id === note.id)?.title ?? note.id,
    lang,
    locales: manifest.locales.map((l) => {
      const id = l.prefix === '' ? baseId : `${l.prefix}${baseId}`;
      return { code: l.code, id, label: l.label, exists: exists.has(id), current: l.code === lang };
    }),
  };
}

export function createLocalBackend(opts: LocalBackendOptions): WikiTransport {
  const { manifest, note, renderer, guest, overlay } = opts;

  const me: MeResponse = {
    user: guest,
    providers: { dev: false, google: 'off', googleSaml: 'off' },
    share: 'off',
    ai: 'off',
  };

  async function putBlock(body: {
    start?: number;
    end?: number;
    hash?: string;
    source?: string;
  }): Promise<unknown> {
    const { start, end, hash, source } = body;
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      typeof hash !== 'string' ||
      typeof source !== 'string'
    ) {
      throw new ApiError(400, 'start, end, hash and source are required');
    }
    const block = overlay.blockAt(start, end);
    if (!block) throw new ApiError(400, `lines ${start}-${end} are not editable here`);
    if ((await sliceHash(block.source)) !== hash) {
      throw new ApiError(409, 'The block changed under you — reload and edit again');
    }
    const edit = overlay.applyEdit(start, end, source);
    if (typeof edit === 'string') throw new ApiError(400, edit);

    // the whole-source gate, exactly as the dev server's save runs it
    const seg = overlay.segments.find((s) => s.key === edit.key)!;
    const nextSource = [
      ...overlay.currentSource.split('\n').slice(0, seg.curStart - 1),
      ...edit.next.split('\n'),
      ...overlay.currentSource.split('\n').slice(seg.curEnd),
    ].join('\n');
    const [{ validateNoteSource }, { site, guard }] = await Promise.all([
      import('../../lib/render-pipeline.ts'),
      opts.inputs(),
    ]);
    const problem = await validateNoteSource(nextSource, {
      site,
      ...(guard ? { guard } : {}),
      mdx: note.mdx,
      path: `/${note.file}`,
    });
    if (problem) throw new ApiError(422, `This edit would not build: ${problem}`);

    const stored = await putOverride(note.id, edit.key, edit.next);
    if (!stored) throw new ApiError(507, 'Browser storage is unavailable — the edit cannot be kept');
    await addRevision({
      id: uid(),
      ts: Date.now(),
      user: guest.name,
      note: note.id,
      lines: `${start}-${end}`,
      via: 'manual',
      before: block.source,
      after: source,
      seg: edit.key,
    });
    // keep the in-memory model coherent until the page reloads
    seg.source = edit.next;
    seg.edited = true;
    return { ok: true };
  }

  async function revert(body: { id?: string }): Promise<unknown> {
    const revisions = await revisionsFor(note.id);
    const rec = revisions.find((r) => r.id === body.id);
    if (!rec) throw new ApiError(404, 'No such revision');
    const seg = overlay.segments.find((s) => s.key === rec.seg);
    if (!seg) throw new ApiError(409, 'The revision no longer matches this page');
    const at = seg.source.indexOf(rec.after);
    if (at < 0 || seg.source.indexOf(rec.after, at + 1) >= 0) {
      throw new ApiError(409, 'The text of this revision no longer matches exactly once');
    }
    const next = seg.source.slice(0, at) + rec.before + seg.source.slice(at + rec.after.length);
    const stored = await putOverride(note.id, seg.key, next);
    if (!stored) throw new ApiError(507, 'Browser storage is unavailable');
    await addRevision({
      id: uid(),
      ts: Date.now(),
      user: guest.name,
      note: note.id,
      lines: rec.lines,
      via: 'revert',
      before: rec.after,
      after: rec.before,
      seg: seg.key,
    });
    seg.source = next;
    seg.edited = true;
    return { ok: true };
  }

  return {
    async request(method: string, path: string, body?: unknown, _opts?: RequestOptions) {
      const url = new URL(path, 'http://local');
      const p = url.pathname;

      if (method === 'GET' && p === '/me') return me;
      if (method === 'POST' && p === '/logout') return { ok: true };
      if (method === 'GET' && p === '/notes') {
        return { notes: (await manifest).notes };
      }
      if (method === 'GET' && p.startsWith('/meta/')) {
        const id = decodeURIComponent(p.slice('/meta/'.length));
        if (id !== note.id) throw new ApiError(404, `Not this page's note: ${id}`);
        return metaOf(note, await manifest);
      }
      if (p.startsWith('/block/')) {
        const id = decodeURIComponent(p.slice('/block/'.length));
        if (id !== note.id) throw new ApiError(404, `Not this page's note: ${id}`);
        if (method === 'GET') {
          const start = Number(url.searchParams.get('start'));
          const end = Number(url.searchParams.get('end'));
          const block = overlay.blockAt(start, end);
          if (!block) throw new ApiError(400, `lines ${start}-${end} are not editable here`);
          return { ...block, hash: await sliceHash(block.source) };
        }
        if (method === 'PUT') return putBlock((body ?? {}) as Parameters<typeof putBlock>[0]);
      }
      if (method === 'POST' && p === '/render') {
        const { markdown } = (body ?? {}) as { markdown?: string };
        if (typeof markdown !== 'string') throw new ApiError(400, 'markdown is required');
        return { html: await renderer.preview(markdown, `/${note.file}`) };
      }
      if (method === 'GET' && p.startsWith('/revisions/')) {
        const id = decodeURIComponent(p.slice('/revisions/'.length));
        // append order, last 100 — the same contract as the dev server's
        // journal read (the client reverses for display)
        const revisions = await revisionsFor(id);
        const shaped: RevisionRecord[] = revisions
          .slice(-100)
          .map(({ seg: _seg, ...rec }) => rec as RevisionRecord);
        return { revisions: shaped };
      }
      if (method === 'POST' && p.startsWith('/revert/')) {
        return revert((body ?? {}) as { id?: string });
      }
      throw new ApiError(404, 'Not available in the playground');
    },
  };
}

export type { LocalRevision };
