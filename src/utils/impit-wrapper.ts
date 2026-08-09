import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Impit } from 'impit';
import { Http } from '../constants.js';
import { getLogger } from './logger.js';
import type { RetryOptions } from './retry.js';
import { retryWithBackoff } from './retry.js';

const impitInstances = new Map<string, Impit>();

/**
 * Get (or lazily create) an Impit client scoped to `key`.
 * Keying by streamer (platformUserId) means concurrent downloads for
 * different streamers never share a client, so one streamer's request
 * volume can't starve or poison another's in-flight requests.
 */
function getImpit(key: string): Impit {
  let instance = impitInstances.get(key);
  if (!instance) {
    instance = new Impit({ browser: 'chrome' });
    impitInstances.set(key, instance);
  }
  return instance;
}

/**
 * Session-based Impit client for persistent connections with browser fingerprints (HLS live downloads)
 */
export class ImpitSession {
  private _closed: boolean = false;
  private _defaultCookies?: string;
  private _defaultUserAgent?: string;

  get defaultCookies(): string | undefined {
    return this._defaultCookies;
  }

  get defaultUserAgent(): string | undefined {
    return this._defaultUserAgent;
  }

  setCloudflareCredentials(cookies: string, userAgent: string): void {
    this._defaultCookies = cookies;
    this._defaultUserAgent = userAgent;
  }

  constructor(private readonly key: string) {
    this.shouldRetryFn = (error) => {
      const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (
        msg.includes('deadline exceeded') ||
        msg.includes('request canceled') ||
        msg.includes('aborted through abortsignal')
      ) {
        return true;
      }
      const match = msg.match(/status\s+(\d+)/);
      const captured = match?.[1];
      if (captured == null || captured === '') return false;
      const status = parseInt(captured, 10);
      return status !== 400 && status !== 401 && status !== 404;
    };
  }

  get closed(): boolean {
    return this._closed;
  }

  private readonly shouldRetryFn: (error: unknown) => boolean;

  private resolveRetryOpts(opts: {
    attempts?: number;
    maxDelayMs?: number;
    shouldRetry?: RetryOptions['shouldRetry'];
  }): RetryOptions {
    return {
      attempts: opts.attempts ?? 1,
      baseDelayMs: Http.DEFAULT_BASE_DELAY_MS,
      maxDelayMs: opts.maxDelayMs ?? Http.DEFAULT_MAX_DELAY_MS,
      shouldRetry: opts.shouldRetry ?? this.shouldRetryFn,
    };
  }

  async fetchText(
    url: string,
    opts?: {
      timeoutMs?: number;
      attempts?: number;
      maxDelayMs?: number;
      shouldRetry?: RetryOptions['shouldRetry'];
      headers?: Record<string, string>;
      userAgent?: string;
      signal?: AbortSignal;
    }
  ): Promise<string> {
    if (this.closed) throw new Error('Session is closed');

    const client = getImpit(this.key);

    getLogger().debug({ url }, 'Impit fetching text');

    const fn = async (): Promise<string> => {
      const signals: AbortSignal[] = [];
      if (opts?.timeoutMs != null) signals.push(AbortSignal.timeout(opts.timeoutMs));
      if (opts?.signal != null) signals.push(opts.signal);
      const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const headers: Record<string, string> = { ...opts?.headers };
      if (opts?.userAgent != null) {
        headers['User-Agent'] = opts.userAgent;
      } else if (this._defaultUserAgent != null) {
        headers['User-Agent'] = this._defaultUserAgent;
      }

      const response = await client.fetch(url, {
        ...(signal != null && { signal }),
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(this._defaultCookies != null && { cookies: this._defaultCookies }),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Impit request failed with status ${response.status}`);
      }

      return await response.text();
    };

    if (!opts || opts.attempts == null) return fn();
    return retryWithBackoff(fn, this.resolveRetryOpts(opts));
  }

  async streamToFile(
    url: string,
    outputPath: string,
    opts?: {
      timeoutMs?: number;
      attempts?: number;
      maxDelayMs?: number;
      shouldRetry?: RetryOptions['shouldRetry'];
      headers?: Record<string, string>;
      userAgent?: string;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    const client = getImpit(this.key);

    getLogger().debug({ url, outputPath }, 'Impit streaming to file');

    const fn = async (): Promise<void> => {
      const signals: AbortSignal[] = [];
      if (opts?.timeoutMs != null) signals.push(AbortSignal.timeout(opts.timeoutMs));
      if (opts?.signal != null) signals.push(opts.signal);
      const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const headers: Record<string, string> = { ...opts?.headers };
      if (opts?.userAgent != null) {
        headers['User-Agent'] = opts.userAgent;
      } else if (this._defaultUserAgent != null) {
        headers['User-Agent'] = this._defaultUserAgent;
      }

      const response = await client.fetch(url, {
        ...(signal != null && { signal }),
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(this._defaultCookies != null && { cookies: this._defaultCookies }),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Impit request failed with status ${response.status}`);
      }

      const writeStream = fs.createWriteStream(outputPath);
      try {
        const nodeStream = Readable.fromWeb(response.body);
        await pipeline(nodeStream, writeStream);
      } catch (err) {
        try {
          await fs.promises.access(outputPath);
          await fs.promises.unlink(outputPath);
        } catch {
          // File doesn't exist or unlink failed — ignore
        }
        throw err;
      }
    };

    if (!opts || opts.attempts == null) return fn();
    return retryWithBackoff(fn, this.resolveRetryOpts(opts));
  }

  close(): void {
    if (this._closed) return;

    this._closed = true;
    getLogger().debug('Impit session closed');
  }
}

/**
 * Create a new session for persistent connections. Session must be explicitly closed when done.
 */
export function createSession(key: string): ImpitSession {
  getLogger().debug({ key }, 'Impit session created');
  return new ImpitSession(key);
}

/**
 * Eagerly initialize Impit at startup so the binary is ready before first request.
 */
export function initImpit(): void {
  getImpit('__init__');
  getLogger().info('Impit initialized');
}

/**
 * Clean up impit client on shutdown (fallback for unclosed sessions)
 */
export function closeImpit(): Promise<void> {
  impitInstances.clear();
  return Promise.resolve();
}
