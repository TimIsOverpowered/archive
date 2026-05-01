import initCycleTLS, { CycleTLSRequestOptions } from 'cycletls';
import fs from 'fs';
import { pipeline } from 'node:stream/promises';
import { getLogger } from './logger.js';
import { Readable } from 'node:stream';
import { getBaseConfig } from '../config/env.js';
import type { RetryOptions } from './retry.js';
import { retryWithBackoff } from './retry.js';
import { HTTP_DEFAULT_BASE_DELAY_MS, HTTP_DEFAULT_MAX_DELAY_MS } from '../constants.js';

type CycleTLSClient = Awaited<ReturnType<typeof initCycleTLS>>;

interface BrowserProfile {
  ja3: string;
  userAgent: string;
  http2Fingerprint: string;
}

const BROWSER_PROFILES: [BrowserProfile, ...BrowserProfile[]] = [
  {
    ja3: '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0',
    userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:87.0) Gecko/20100101 Firefox/87.0',
    http2Fingerprint: '1:65536;2:0;4:131072;5:16384|12517377|0|m,p,a,s',
  },
  {
    ja3: '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0',
    userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
    http2Fingerprint: '1:65536;2:0;4:131072;5:16384|12517377|0|m,p,a,s',
  },
  {
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36',
    http2Fingerprint: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  },
  {
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.54 Safari/537.36',
    http2Fingerprint: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  },
];

const DEFAULT_PROFILE = BROWSER_PROFILES[0];

function pickFingerprint(): BrowserProfile {
  const idx = Math.floor(Math.random() * BROWSER_PROFILES.length);
  const profile = BROWSER_PROFILES[idx];
  return profile ?? DEFAULT_PROFILE;
}

let cycleTLSInstance: CycleTLSClient | null = null;
let initPromise: Promise<CycleTLSClient> | null = null;

/**
 * Initialize cycletls client (singleton pattern with Promise-based lock)
 */
async function getCycleTLS(): Promise<CycleTLSClient> {
  if (cycleTLSInstance?.exit) return cycleTLSInstance;

  initPromise ??= (async () => {
    try {
      getLogger().debug('Initializing CycleTLS with Firefox fingerprint');

      const instance = await initCycleTLS({
        debug: getBaseConfig().NODE_ENV === 'development',
        timeout: 30000,
      });

      cycleTLSInstance = instance;
      return instance;
    } catch (err: unknown) {
      const error = err as Error & { code?: string };

      if (error.code === 'ENOENT') {
        throw new Error('CycleTLS executable not found. Please ensure cycletls package was installed correctly.');
      } else {
        getLogger().error({ message: error.message }, 'Failed to initialize CycleTLS');
        throw new Error(`Failed to initialize CycleTLS: ${error.message}`);
      }
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Session-based CycleTLS client for persistent connections (HLS live downloads)
 */
export class CycleTLSSession {
  private _closed: boolean = false;
  private _profile: BrowserProfile;

  constructor() {
    this._profile = pickFingerprint();
    this.shouldRetryFn = (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      const match = msg.match(/status\s+(\d+)/);
      const captured = match?.[1];
      if (captured == null || captured === '') return false;
      const status = parseInt(captured, 10);
      return status === 429 || status === 408 || (status >= 500 && status < 600);
    };
  }

  get closed(): boolean {
    return this._closed;
  }

  private readonly shouldRetryFn: (error: unknown) => boolean;

  private resolveRetryOpts(opts: {
    attempts: number;
    maxDelayMs?: number;
    shouldRetry?: RetryOptions['shouldRetry'];
  }): RetryOptions {
    return {
      attempts: opts.attempts,
      baseDelayMs: HTTP_DEFAULT_BASE_DELAY_MS,
      maxDelayMs: opts.maxDelayMs ?? HTTP_DEFAULT_MAX_DELAY_MS,
      shouldRetry: opts.shouldRetry ?? this.shouldRetryFn,
    };
  }

  async fetchText(
    url: string,
    retryOpts?: { attempts: number; maxDelayMs?: number; shouldRetry?: RetryOptions['shouldRetry'] }
  ): Promise<string> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    getLogger().debug({ url }, 'CycleTLS fetching text');

    const fn = async (): Promise<string> => {
      const response = await client.get(url, {
        ja3: this._profile.ja3,
        userAgent: this._profile.userAgent,
        http2Fingerprint: this._profile.http2Fingerprint,
        responseType: 'text',
        enableConnectionReuse: true, // missing from CycleTLSRequestOptions
      } as unknown as CycleTLSRequestOptions);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`CycleTLS request failed with status ${response.status}`);
      }

      return response.data as string;
    };

    if (!retryOpts) return fn();
    return retryWithBackoff(fn, this.resolveRetryOpts(retryOpts));
  }

  async streamToFile(
    url: string,
    outputPath: string,
    retryOpts?: { attempts: number; maxDelayMs?: number; shouldRetry?: RetryOptions['shouldRetry'] }
  ): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    getLogger().debug({ url, outputPath }, 'CycleTLS streaming to file');

    const fn = async (): Promise<void> => {
      const response = await client.get(url, {
        ja3: this._profile.ja3,
        userAgent: this._profile.userAgent,
        http2Fingerprint: this._profile.http2Fingerprint,
        responseType: 'stream',
        enableConnectionReuse: true, // missing from CycleTLSRequestOptions
      } as unknown as CycleTLSRequestOptions);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`CycleTLS request failed with status ${response.status}`);
      }

      const writeStream = fs.createWriteStream(outputPath);
      try {
        const stream = response.data as Readable;
        await pipeline(stream, writeStream);
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

    if (!retryOpts) return fn();
    return retryWithBackoff(fn, this.resolveRetryOpts(retryOpts));
  }

  close(): void {
    if (this._closed) return;

    this._closed = true;
    getLogger().debug('CycleTLS session closed');
  }
}

/**
 * Create a new session for persistent connections. Session must be explicitly closed when done.
 */
export function createSession(): CycleTLSSession {
  getLogger().debug('CycleTLS session created');
  return new CycleTLSSession();
}

/**
 * Clean up cycletls client on shutdown (fallback for unclosed sessions)
 */
export async function closeCycleTLS(): Promise<void> {
  if (cycleTLSInstance?.exit) {
    getLogger().debug({ component: 'cycletls' }, 'Force closing all sessions');
    await cycleTLSInstance.exit().catch(() => {});
    cycleTLSInstance = null;
  }
}
