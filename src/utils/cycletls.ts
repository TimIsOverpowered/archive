import initCycleTLS from 'cycletls';
import fs from 'fs';
import { logger } from './logger.js';

type CycleTLSClient = Awaited<ReturnType<typeof initCycleTLS>>;

const LEGACY_FIREFOX_JA3 = '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-24-25-256-257,0';
const LEGACY_FIREFOX_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:87.0) Gecko/20100101 Firefox/87.0';

let cycleTLSInstance: CycleTLSClient | null = null;
let isInitializing = false;
let initError: Error | null = null;
let activeSessionCount = 0;

/**
 * Initialize cycletls client (singleton pattern like legacy code)
 */
async function getCycleTLS(): Promise<CycleTLSClient> {
  if (!cycleTLSInstance && !isInitializing) {
    isInitializing = true;

    try {
      logger.debug('Initializing CycleTLS with Firefox fingerprint');

      cycleTLSInstance = await initCycleTLS({
        debug: process.env.NODE_ENV === 'development',
        timeout: 30000,
      });

      isInitializing = false;
    } catch (err: any) {
      const error = err as Error & { code?: string };

      if (error.code === 'ENOENT') {
        initError = new Error('CycleTLS executable not found. Please ensure cycletls package was installed correctly.');
      } else {
        initError = new Error(`Failed to initialize CycleTLS: ${err.message}`);
      }

      logger.error({ err: error.message }, 'Failed to initialize CycleTLS');

      cycleTLSInstance = null;
      isInitializing = false;
    }
  }

  if (initError) {
    throw initError;
  }

  if (!cycleTLSInstance && !isInitializing) {
    throw new Error('CycleTLS failed to initialize. Check logs for details.');
  }

  return cycleTLSInstance!;
}

/**
 * Session-based CycleTLS client for persistent connections (HLS live downloads)
 */
export class CycleTLSSession {
  private closed: boolean = false;

  async fetchText(url: string): Promise<string> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    logger.debug({ url }, `[CycleTLS Session] Fetching text from ${url}`);

    const response = await client.get(url, {
      ja3: LEGACY_FIREFOX_JA3,
      userAgent: LEGACY_FIREFOX_UA,
      responseType: 'text',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CycleTLS request failed with status ${response.status}`);
    }

    return await response.text();
  }

  async streamToFile(url: string, outputPath: string): Promise<void> {
    if (this.closed) throw new Error('Session is closed');

    const client = await getCycleTLS();

    logger.debug({ url }, `[CycleTLS Session] Streaming to file ${outputPath}`);

    return new Promise((resolve, reject) => {
      client
        .get(url, {
          ja3: LEGACY_FIREFOX_JA3,
          userAgent: LEGACY_FIREFOX_UA,
          responseType: 'stream',
        })
        .then((response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`CycleTLS request failed with status ${response.status}`));
            return;
          }

          const writeStream = fs.createWriteStream(outputPath);

          response.data.pipe(writeStream).on('finish', resolve).on('error', reject);
        })
        .catch(reject);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    activeSessionCount--;

    logger.debug({ activeSessions: activeSessionCount }, `[CycleTLS Session] Closed. Active sessions: ${activeSessionCount}`);

    // Auto-exit client when no more active sessions
    if (activeSessionCount <= 0 && cycleTLSInstance) {
      try {
        await cycleTLSInstance.exit();
        cycleTLSInstance = null;
        logger.debug('[CycleTLS] Client exited (no active sessions)');
      } catch {}
    }
  }
}

/**
 * Create a new session for persistent connections. Session must be explicitly closed when done.
 */
export function createSession(): CycleTLSSession {
  activeSessionCount++;
  logger.debug({ activeSessions: activeSessionCount }, `[CycleTLS] Created session #${activeSessionCount}`);
  return new CycleTLSSession();
}

/**
 * Clean up cycletls client on shutdown (fallback for unclosed sessions)
 */
export async function closeCycleTLS(): Promise<void> {
  if (cycleTLSInstance) {
    logger.debug('[CycleTLS] Force closing all sessions');
    await cycleTLSInstance.exit().catch(() => {});
    cycleTLSInstance = null;
    activeSessionCount = 0;
  }
}
