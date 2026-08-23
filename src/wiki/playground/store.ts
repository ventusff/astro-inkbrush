/**
 * Browser-local persistence for the playground: everything a visitor edits
 * lives in THEIR IndexedDB — nothing ever leaves the browser. One database,
 * three stores:
 *
 *   notes      note id → { segments: Record<origKey, source> } — per-segment
 *              source overrides keyed by the segment's line range in the
 *              ORIGINAL build ("start-end"), the one stable coordinate system
 *              (the static HTML's stamps never change between visits)
 *   revisions  autoincrement → RevisionRecord + { seg } — the local edit
 *              journal (the history panel reads it; revert addresses the
 *              overridden segment through `seg`)
 *   meta       'identity' → { name } — the visitor's self-chosen pen name
 *
 * Every call opens lazily and fails soft: storage being unavailable
 * (private windows, blocked site data) must degrade to read-only, never
 * throw into the UI.
 */
import type { RevisionRecord } from '../shared/types';

export interface NoteOverrides {
  segments: Record<string, string>;
  updated: number;
}

export type LocalRevision = RevisionRecord & { seg: string };

const DB_NAME = 'inkbrush-playground';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolvePromise) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes');
        if (!db.objectStoreNames.contains('revisions')) {
          const store = db.createObjectStore('revisions', { autoIncrement: true });
          store.createIndex('note', 'note');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolvePromise(req.result);
      req.onerror = () => resolvePromise(null);
      req.onblocked = () => resolvePromise(null);
    } catch {
      resolvePromise(null);
    }
  });
  return dbPromise;
}

function requestOf<T>(make: (db: IDBDatabase) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolvePromise) => {
        if (!db) return resolvePromise(null);
        try {
          const req = make(db);
          req.onsuccess = () => resolvePromise(req.result);
          req.onerror = () => resolvePromise(null);
        } catch {
          resolvePromise(null);
        }
      }),
  );
}

export async function getOverrides(noteId: string): Promise<NoteOverrides | null> {
  const rec = await requestOf<unknown>((db) =>
    db.transaction('notes').objectStore('notes').get(noteId),
  );
  if (!rec || typeof rec !== 'object') return null;
  const { segments, updated } = rec as NoteOverrides;
  return segments && typeof segments === 'object' ? { segments, updated: updated ?? 0 } : null;
}

export async function putOverride(noteId: string, segKey: string, source: string): Promise<boolean> {
  const current = (await getOverrides(noteId)) ?? { segments: {}, updated: 0 };
  current.segments[segKey] = source;
  current.updated = Date.now();
  const ok = await requestOf((db) =>
    db.transaction('notes', 'readwrite').objectStore('notes').put(current, noteId),
  );
  return ok !== null;
}

export async function addRevision(rec: LocalRevision): Promise<void> {
  await requestOf((db) => db.transaction('revisions', 'readwrite').objectStore('revisions').add(rec));
}

export async function revisionsFor(noteId: string): Promise<LocalRevision[]> {
  const all = await requestOf<unknown[]>((db) =>
    db.transaction('revisions').objectStore('revisions').index('note').getAll(noteId),
  );
  return (all ?? []) as LocalRevision[];
}

/** any local state at all? (the boot probe: nothing stored → nothing to apply) */
export async function hasOverrides(noteId: string): Promise<boolean> {
  const rec = await getOverrides(noteId);
  return rec !== null && Object.keys(rec.segments).length > 0;
}

/** wipe every local edit and the journal — the visitor's reset button */
export async function resetAll(): Promise<void> {
  await requestOf((db) => db.transaction('notes', 'readwrite').objectStore('notes').clear());
  await requestOf((db) =>
    db.transaction('revisions', 'readwrite').objectStore('revisions').clear(),
  );
}

export async function getIdentity(): Promise<{ name: string } | null> {
  const rec = await requestOf<unknown>((db) =>
    db.transaction('meta').objectStore('meta').get('identity'),
  );
  return rec && typeof rec === 'object' && 'name' in rec ? (rec as { name: string }) : null;
}

export async function setIdentity(name: string): Promise<void> {
  await requestOf((db) =>
    db.transaction('meta', 'readwrite').objectStore('meta').put({ name }, 'identity'),
  );
}
