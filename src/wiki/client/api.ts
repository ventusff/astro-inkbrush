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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
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
 * on non-2xx before the stream starts.
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
}
