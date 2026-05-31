import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Impit } from 'impit';
import { Http } from '../constants.js';
import { getLogger } from './logger.js';
import type { RetryOptions } from './retry.js';
import { retryWithBackoff } from './retry.js';

let impitInstance: Impit | null = null;

/**
 * Initialize impit client (singleton pattern)
 */
function getImpit(): Impit {
  impitInstance ??= new Impit({
    browser: 'chrome',
  });
  return impitInstance;
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

  constructor() {
    this.shouldRetryFn = (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('deadline exceeded') || msg.includes('request canceled')) {
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
    }
  ): Promise<string> {
    if (this.closed) throw new Error('Session is closed');

    const client = getImpit();

    getLogger().debug({ url }, 'Impit fetching text');

    const fn = async (): Promise<string> => {
      const signals: AbortSignal[] = [];
      if (opts?.timeoutMs != null) signals.push(AbortSignal.timeout(opts.timeoutMs));
      const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const headers: Record<string, string> = { ...opts?.headers };
      if (opts?.userAgent != null) {
        headers['User-Agent'] = opts.userAgent;
      } else if (this._defaultUserAgent != null) {
        headers['User-Agent'] = this._defaultUserAgent;
      }

      const response = await client.fetch(url, {
        signal: signal as AbortSignal,
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
    }
  ): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    const client = getImpit();

    getLogger().debug({ url, outputPath }, 'Impit streaming to file');

    const fn = async (): Promise<void> => {
      const signals: AbortSignal[] = [];
      if (opts?.timeoutMs != null) signals.push(AbortSignal.timeout(opts.timeoutMs));
      const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const headers: Record<string, string> = { ...opts?.headers };
      if (opts?.userAgent != null) {
        headers['User-Agent'] = opts.userAgent;
      } else if (this._defaultUserAgent != null) {
        headers['User-Agent'] = this._defaultUserAgent;
      }

      const response = await client.fetch(url, {
        signal: signal as AbortSignal,
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
export function createSession(): ImpitSession {
  getLogger().debug('Impit session created');
  return new ImpitSession();
}

/**
 * Eagerly initialize Impit at startup so the binary is ready before first request.
 */
export function initImpit(): void {
  getImpit();
  getLogger().info('Impit initialized');
}

/**
 * Clean up impit client on shutdown (fallback for unclosed sessions)
 */
export function closeImpit(): Promise<void> {
  impitInstance = null;
  return Promise.resolve();
}
