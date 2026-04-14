import fsPromises from 'fs/promises';
import { extractErrorDetails, createErrorContext, throwOnHttpError } from '../../utils/error.js';
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { sleep } from '../../utils/delay.js';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import pLimit from 'p-limit';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { fileExists } from '../../utils/path.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch/index.js';
import { retryWithBackoff } from '../../utils/retry.js';

export type DownloadStrategy = { type: 'fetch'; signal?: AbortSignal } | { type: 'cycletls'; session: CycleTLSSession };

export interface FetchPlaylistResult {
  variantM3u8String: string;
  baseURL: string;
}

/**
 * Download segments in parallel using p-limit for concurrency control
 * Universal function - works with both .ts and .mp4 (fMP4) segments
 * Supports both fetch (Twitch) and CycleTLS (Kick) download strategies
 */
export async function downloadSegmentsParallel(
  segments: { uri: string }[],
  vodDir: string,
  baseURL: string,
  strategy: DownloadStrategy,
  concurrency: number,
  retryAttempts: number,
  log: ReturnType<typeof createAutoLogger>,
  onBatchComplete?: (completedCount: number) => void
): Promise<void> {
  const limit = pLimit(concurrency);
  let completedCount = 0;
  const totalSegments = segments.length;

  log.debug({ count: totalSegments, concurrency, retryAttempts, strategy: strategy.type }, `Starting parallel segment download`);

  const isAborted = () => (strategy.type === 'fetch' ? strategy.signal?.aborted : strategy.session.closed);

  await Promise.all(
    segments.map(async (segment) => {
      if (isAborted()) {
        return;
      }

      const outputPath = pathMod.join(vodDir, segment.uri);
      const tempPath = outputPath + '.tmp';

      const exists = await fileExists(outputPath);

      if (exists) {
        completedCount++;
        return;
      }

      try {
        await retryWithBackoff(
          async () => {
            if (isAborted()) {
              throw new Error('Aborted');
            }
            await limit(async () => {
              if (strategy.type === 'fetch') {
                const response = await fetch(`${baseURL}/${segment.uri}`, { signal: strategy.signal });
                throwOnHttpError(response, 'Download segment');

                const writer = fs.createWriteStream(tempPath);
                const nodeWebStream = response.body as unknown as NodeWebStream<Uint8Array>;
                await pipeline(Readable.fromWeb(nodeWebStream), writer);
              } else {
                await strategy.session.streamToFile(`${baseURL}/${segment.uri}`, tempPath);
              }
            });
          },
          {
            attempts: retryAttempts,
            baseDelayMs: 1000,
            maxDelayMs: 30000,
            jitter: true,
            shouldRetry: (error) => {
              if (isAborted()) return false;
              const msg = error instanceof Error ? error.message : String(error);
              return msg !== 'Aborted';
            },
          }
        );

        await fsPromises.rename(tempPath, outputPath);
        completedCount++;

        log.debug({ uri: segment.uri, current: completedCount, total: totalSegments }, `Segment downloaded`);
      } catch (error: unknown) {
        if (isAborted()) {
          return;
        }

        const lastError = error instanceof Error ? error : new Error(String(error));

        try {
          await fsPromises.unlink(tempPath).catch(() => {});
        } catch {}

        log.debug({ uri: segment.uri, error: lastError.message }, `Failed to download segment`);
        throw lastError;
      }
    })
  );

  if (!isAborted()) {
    log.debug({ total: totalSegments }, `All segments downloaded successfully`);
    if (onBatchComplete) {
      onBatchComplete(completedCount);
    }
  }
}

export async function cleanupOrphanedTmpFiles(vodDir: string, log: ReturnType<typeof createAutoLogger>): Promise<void> {
  try {
    const files = await fsPromises.readdir(vodDir);

    for (const file of files) {
      if (file.endsWith('.tmp')) {
        const filePath = pathMod.join(vodDir, file);

        try {
          await fsPromises.unlink(filePath);
          log.debug(`Cleaned up orphaned .tmp file: ${file}`);
        } catch (error) {
          log.warn({ error: extractErrorDetails(error).message }, `Failed to clean up orphaned .tmp file: ${file}`);
        }
      }
    }
  } catch (error) {
    log.warn({ error: extractErrorDetails(error).message }, `Failed to scan for orphaned files in directory`);
  }
}

export async function fetchTwitchPlaylist(
  vodId: string,
  log: ReturnType<typeof createAutoLogger>,
  retryCount: number,
  maxRetryBeforeEndDetection: number,
  tenantId?: string
): Promise<FetchPlaylistResult | null> {
  const tokenSig = await getVodTokenSig(vodId, tenantId);

  try {
    const masterPlaylistContent = await getTwitchM3u8(String(vodId), tokenSig.value, tokenSig.signature);

    if (!masterPlaylistContent) {
      log.error(`[${vodId}] Failed to fetch Twitch master playlist`);

      if (retryCount > maxRetryBeforeEndDetection) {
        log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
        return null;
      }

      await sleep(5000 * Math.min(retryCount, 6));
      return null;
    }

    const parsedMaster: HLS.types.MasterPlaylist | HLS.types.MediaPlaylist = HLS.parse(masterPlaylistContent);

    if (!parsedMaster) {
      log.error(`[${vodId}] Failed to parse Twitch master playlist`);

      await sleep(5000);
      return null;
    }

    const bestVariantUrl = (parsedMaster as HLS.types.MasterPlaylist).variants?.[0]?.uri || parsedMaster.uri;

    if (!bestVariantUrl) {
      log.error(`[${vodId}] No variant URL found in master playlist`);
      return null;
    }
    let baseURL: string = '';
    let variantM3u8String: string = '';

    if (!bestVariantUrl.startsWith('http')) {
      baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));

      const response1 = await fetch(bestVariantUrl.includes('/') ? bestVariantUrl : `${baseURL}/${bestVariantUrl}`);
      if (!response1.ok) throw new Error(`Fetch failed with status ${response1.status}`);
      variantM3u8String = await response1.text();
    } else {
      baseURL = bestVariantUrl.substring(0, bestVariantUrl.lastIndexOf('/'));

      const response2 = await fetch(bestVariantUrl);
      if (!response2.ok) throw new Error(`Fetch failed with status ${response2.status}`);
      variantM3u8String = await response2.text();
    }

    return { variantM3u8String, baseURL };
  } catch (error: unknown) {
    log.error(createErrorContext(error, { vodId }), `[${vodId}] Failed to get Twitch HLS playlist`);

    if (retryCount > maxRetryBeforeEndDetection) {
      log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
      return null;
    }

    await sleep(5000 * Math.min(retryCount, 6));
    return null;
  }
}

export async function fetchKickPlaylist(
  vodId: string,
  sourceUrl: string | undefined,
  log: ReturnType<typeof createAutoLogger>,
  retryCount: number,
  maxRetryBeforeEndDetection: number,
  session?: CycleTLSSession
): Promise<FetchPlaylistResult | null> {
  const fetchUrl = sourceUrl || '';

  if (!fetchUrl) {
    log.error(`[${vodId}] No Kick HLS source URL provided. Cannot continue download.`);

    await sleep(5000);

    if (retryCount > maxRetryBeforeEndDetection * 2) {
      log.error(`[${vodId}] Aborting download - no source URL available after multiple attempts`);
      return null;
    }

    return null;
  }

  let baseURL: string = '';

  try {
    const tempSession = session || createSession(); // Create if not provided

    if (fetchUrl.includes('master.m3u8')) {
      const baseEndpoint = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
      baseURL = `${baseEndpoint}/1080p60`;

      const variantM3u8String = await tempSession.fetchText(`${baseURL}/playlist.m3u8`);

      if (!session) {
        await tempSession.close(); // Only close temporary sessions
      }

      return { variantM3u8String, baseURL };
    } else {
      const response = await tempSession.fetchText(fetchUrl);

      baseURL = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));

      if (!session) {
        await tempSession.close();
      }

      return { variantM3u8String: response, baseURL };
    }
  } catch (error: unknown) {
    log.error(createErrorContext(error, { vodId }), `[${vodId}] Failed to fetch Kick HLS playlist`);

    await sleep(5000 * Math.min(retryCount, 6));

    if (retryCount > maxRetryBeforeEndDetection) {
      log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
      return null;
    }

    return null;
  }
}
