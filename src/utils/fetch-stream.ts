import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { throwOnHttpError } from './error.js';

const DEFAULT_JSON_TIMEOUT_MS = 20_000;
const DEFAULT_FILE_TIMEOUT_MS = 120_000;

/**
 * Fetch URL as stream and write to file
 */
export async function fetchToFile(url: string, outputPath: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<void> {
  const timeout = options?.timeout ?? DEFAULT_FILE_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeout);

  try {
    const response = await fetch(url, {
      signal,
      headers: options?.headers ? new Headers(options.headers) : undefined,
    });

    throwOnHttpError(response, 'Fetch');

    const nodeWritable = fs.createWriteStream(outputPath);

    // FIX: Cast the web body to WebReadableStream to satisfy Readable.fromWeb
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), nodeWritable);
  } catch (err: unknown) {
    if (fs.existsSync(outputPath)) {
      await fs.promises.unlink(outputPath).catch(() => {});
    }

    // FIX: Safe error checking instead of 'any'
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new Error(`File download timed out after ${timeout / 1000}s`);
      }
      throw err;
    }
    throw new Error(String(err));
  }
}

/**
 * Fetch URL and return response body as text
 */
export async function fetchText(url: string, options?: { headers?: Record<string, string>; signal?: AbortSignal; timeout?: number }): Promise<string> {
  const timeout = options?.timeout ?? DEFAULT_JSON_TIMEOUT_MS;
  const signal = options?.signal ?? AbortSignal.timeout(timeout);

  const response = await fetch(url, {
    signal,
    headers: options?.headers ? new Headers(options.headers) : undefined,
  });

  throwOnHttpError(response, 'Fetch');

  return response.text();
}

/**
 * Fetch URL and parse JSON response
 */
export async function fetchJson<T = unknown>(
  url: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: unknown; // FIX: Use unknown instead of any for request bodies
    signal?: AbortSignal;
    timeout?: number;
  }
): Promise<T> {
  const method = options?.method ?? 'GET';
  const timeout = options?.timeout ?? DEFAULT_JSON_TIMEOUT_MS;
  const signal = options?.signal ?? AbortSignal.timeout(timeout);

  const headers = new Headers(options?.headers ?? {});

  if (options?.body !== undefined && method !== 'GET') {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  const fetchOpts: RequestInit = {
    method,
    headers,
    signal,
    body: options?.body !== undefined && method !== 'GET' ? JSON.stringify(options.body) : undefined,
  };

  const response = await fetch(url, fetchOpts);

  throwOnHttpError(response, 'Fetch JSON');

  // FIX: JSON parsing is inherently unknown, so we cast to our generic T
  const data = await response.json();
  return data as T;
}

export default fetchJson;
