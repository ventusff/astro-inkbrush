/** fetch helpers for /api/wiki, incl. the NDJSON stream reader for claude jobs */
import type { ClaudeStreamEvent } from '../shared/types';

const BASE = '/api/wiki';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestOptions {
  /** aborts the underlying fetch (the promise rejects with the abort error) */
  signal?: AbortSignal | undefined;
}

/**
 * The client's one data seam. Every feature module calls `api.*`; by default
 * requests go over HTTP to the dev server's `/api/wiki` middleware. A
 * playground/testing host may install a transport that serves the same
 * surface from somewhere else (e.g. browser-local storage) — it must resolve
 * with the parsed response body or throw ApiError, exactly like HTTP does.
 * Never installed in normal WIKI mode.
 */
export interface WikiTransport {
  request(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<unknown>;
}

let transport: WikiTransport | null = null;

export function setWikiTransport(next: WikiTransport | null): void {
  transport = next;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  if (transport) return (await transport.request(method, path, body, opts)) as T;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : null,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/**
 * POST an NDJSON-streaming endpoint; yields each parsed line. Throws ApiError
 * on non-2xx before the stream starts. A consumer that stops early (break /
 * return / throw) cancels the response body, so the connection closes and
 * the server sees the disconnect; `signal` additionally aborts the fetch.
 */
export async function* stream<T = ClaudeStreamEvent>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as T;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
