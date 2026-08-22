/**
 * Flat-file persistence for the wiki: everything lives under `.wiki/` at the
 * repo root (git-ignored). No database — comments/revisions are append-only
 * NDJSON, small state is JSON, and the session secret is a generated file.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let root = process.cwd();

/** called once by the middleware entry with the astro project root */
export function setProjectRoot(dir: string): void {
  root = dir;
}

export function projectRoot(): string {
  return root;
}

export function wikiDataDir(...segments: string[]): string {
  const dir = join(root, '.wiki', 'data', ...segments);
  return dir;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** HMAC secret for session cookies — generated on first run */
export function sessionSecret(): string {
  const file = join(root, '.wiki', 'secret');
  if (!existsSync(file)) {
    ensureDir(dirname(file));
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(file, 'utf8').trim();
}

export function appendNdjson(file: string, record: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // tolerate a torn tail line (crash mid-append)
    }
  }
  return out;
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2));
}
