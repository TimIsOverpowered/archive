import initCycleTLS from 'cycletls';
import fs from 'fs';
import { pipeline } from 'node:stream/promises';
import { logger } from './logger.js';
import { Readable } from 'node:stream';

type CycleTLSClient = Awaited<ReturnType<typeof initCycleTLS>>;

const LEGACY_FIREFOX_JA3 = '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0';
const LEGACY_FIREFOX_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:87.0) Gecko/20100101 Firefox/87.0';

let cycleTLSInstance: CycleTLSClient | null = null;
let initPromise: Promise<CycleTLSClient> | null = null;

/**
 * Initialize cycletls client (singleton pattern with Promise-based lock)
 */
async function getCycleTLS(): Promise<CycleTLSClient> {
  if (cycleTLSInstance?.exit) return cycleTLSInstance;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        logger.debug('Initializing CycleTLS with Firefox fingerprint');

        const instance = await initCycleTLS({
          debug: process.env.NODE_ENV === 'development',
          timeout: 30000,
        });

        cycleTLSInstance = instance;
        return instance;
      } catch (err: unknown) {
        const error = err as Error & { code?: string };

        if (error.code === 'ENOENT') {
          throw new Error('CycleTLS executable not found. Please ensure cycletls package was installed correctly.');
        } else {
          logger.error({ message: error.message }, 'Failed to initialize CycleTLS');
          throw new Error(`Failed to initialize CycleTLS: ${error.message}`);
        }
      } finally {
        initPromise = null;
      }
    })();
  }

  return initPromise;
}

/**
 * Session-based CycleTLS client for persistent connections (HLS live downloads)
 */
export class CycleTLSSession {
  private closed: boolean = false;

  async fetchText(url: string): Promise<string> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    logger.debug({ url }, `[CycleTLS] Fetching text from ${url}`);

    const response = await client.get(url, {
      ja3: LEGACY_FIREFOX_JA3,
      userAgent: LEGACY_FIREFOX_UA,
      responseType: 'text',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CycleTLS request failed with status ${response.status}`);
    }

    // For text responses, data is already parsed as string in cycletls v2.x
    return response.data;
  }

  async streamToFile(url: string, outputPath: string): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    logger.debug({ url }, `[CycleTLS] Streaming to file ${outputPath}`);

    const response = await client.get(url, {
      ja3: LEGACY_FIREFOX_JA3,
      userAgent: LEGACY_FIREFOX_UA,
      responseType: 'stream',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CycleTLS request failed with status ${response.status}`);
    }

    const writeStream = fs.createWriteStream(outputPath);
    try {
      const stream = response.data as Readable;
      await pipeline(stream, writeStream);
    } catch (err) {
      if (fs.existsSync(outputPath)) {
        await fs.promises.unlink(outputPath).catch(() => {});
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    logger.debug(`[CycleTLS] Closed`);
  }
}

/**
 * Create a new session for persistent connections. Session must be explicitly closed when done.
 */
export function createSession(): CycleTLSSession {
  logger.debug(`[CycleTLS] Created session`);
  return new CycleTLSSession();
}

/**
 * Clean up cycletls client on shutdown (fallback for unclosed sessions)
 */
export async function closeCycleTLS(): Promise<void> {
  if (cycleTLSInstance?.exit) {
    logger.debug('[CycleTLS] Force closing all sessions');
    await cycleTLSInstance.exit().catch(() => {});
    cycleTLSInstance = null;
  }
}
