import { pipeline } from 'node:stream/promises';
import fs from 'fs';

/**
 * Fetch URL as stream and write to file (replaces axios responseType: 'stream')
 */
export async function fetchToFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  const nodeWritable = fs.createWriteStream(outputPath);

  // Stream chunks directly to file
  for await (const chunk of response.body as any) {
    nodeWritable.write(chunk);
  }
  nodeWritable.end();
}

/**
 * Fetch URL and return response body as text/string (replaces axios .data)
 */
export async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const opts: RequestInit = {};

  if (headers) {
    const h: HeadersInit = new Headers();
    Object.entries(headers).forEach(([k, v]) => h.append(k, v));
    opts.headers = h;
  }

  const response = await fetch(url, opts);

  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);

  return response.text();
}

/**
 * Fetch URL and parse JSON response (replaces axios .data after json())
 */
export async function fetchJson<T>(url: string, options?: { method?: 'GET' | 'POST' | 'PATCH'; headers?: Record<string, string>; body?: any; signal?: AbortSignal }): Promise<T> {
  const opts: RequestInit = {};

  if (options?.method) opts.method = options.method;
  if (options?.headers) {
    const h: HeadersInit = new Headers();
    Object.entries(options.headers).forEach(([k, v]) => h.append(k, v));
    opts.headers = h;
  }

  if (options?.body !== undefined && !['GET'].includes(opts.method!)) {
    opts.body = JSON.stringify(options.body);
    const existingHeaders: HeadersInit | undefined = opts.headers || new Headers();
    Object.assign(existingHeaders as any, { 'Content-Type': 'application/json' });
  }

  if (options?.signal) opts.signal = options.signal;

  const response = await fetch(url, opts);

  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);

  return response.json() as Promise<T>;
}
