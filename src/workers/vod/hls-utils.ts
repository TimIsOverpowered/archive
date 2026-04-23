import { extractErrorDetails, createErrorContext } from '../../utils/error.js';
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { sleep } from '../../utils/delay.js';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import pLimit from 'p-limit';
import type { AppLogger } from '../../utils/logger.js';
import { fileExists } from '../../utils/path.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch/index.js';
import { request, segmentDownloadAgent } from '../../utils/http-client.js';

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
  log: AppLogger,
  onBatchComplete?: (completedCount: number) => void
): Promise<void> {
  const limit = pLimit(concurrency);
  let completedCount = 0;
  const totalSegments = segments.length;

  log.debug(
    { count: totalSegments, concurrency, retryAttempts, strategy: strategy.type },
    `Starting parallel segment download`
  );

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
        await limit(async () => {
          if (isAborted()) {
            throw new Error('Aborted');
          }

          if (strategy.type === 'fetch') {
            const response = await request(`${baseURL}/${segment.uri}`, {
              responseType: 'response',
              signal: strategy.signal,
              timeoutMs: 30000,
              dispatcher: segmentDownloadAgent,
              retryOptions: {
                attempts: retryAttempts,
              },
            });

            const writer = fs.createWriteStream(tempPath);
            const nodeWebStream = response.body as NodeWebStream<Uint8Array>;
            await pipeline(Readable.fromWeb(nodeWebStream), writer);
          } else {
            await strategy.session.streamToFile(`${baseURL}/${segment.uri}`, tempPath);
          }
        });

        await fs.promises.rename(tempPath, outputPath);
        completedCount++;

        log.debug({ uri: segment.uri, current: completedCount, total: totalSegments }, `Segment downloaded`);
      } catch (error: unknown) {
        if (isAborted()) {
          return;
        }

        const lastError = error instanceof Error ? error : new Error(String(error));

        try {
          await fs.promises.unlink(tempPath).catch(() => {});
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

export async function cleanupOrphanedTmpFiles(vodDir: string, log: AppLogger): Promise<void> {
  try {
    const files = await fs.promises.readdir(vodDir);

    for (const file of files) {
      if (file.endsWith('.tmp')) {
        const filePath = pathMod.join(vodDir, file);

        try {
          await fs.promises.unlink(filePath);
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
  log: AppLogger,
  retryCount: number,
  maxRetryBeforeEndDetection: number,
  tenantId?: string
): Promise<FetchPlaylistResult | null> {
  const tokenSig = await getVodTokenSig(vodId, tenantId);

  try {
    const masterPlaylistContent = await getTwitchM3u8(String(vodId), tokenSig.value, tokenSig.signature);

    if (!masterPlaylistContent) {
      log.error({ vodId }, 'Failed to fetch Twitch master playlist');

      if (retryCount > maxRetryBeforeEndDetection) {
        log.warn({ vodId }, 'Too many consecutive failures. Assuming stream ended or platform issue.');
        return null;
      }

      await sleep(5000 * Math.min(retryCount, 6));
      return null;
    }

    const parsedMaster: HLS.types.MasterPlaylist | HLS.types.MediaPlaylist = HLS.parse(masterPlaylistContent);

    if (!parsedMaster) {
      log.error({ vodId }, 'Failed to parse Twitch master playlist');

      await sleep(5000);
      return null;
    }

    const bestVariantUrl = (parsedMaster as HLS.types.MasterPlaylist).variants?.[0]?.uri || parsedMaster.uri;

    if (!bestVariantUrl) {
      log.error({ vodId }, 'No variant URL found in master playlist');
      return null;
    }
    let baseURL: string = '';
    let variantM3u8String: string = '';

    if (!bestVariantUrl.startsWith('http')) {
      baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));

      variantM3u8String = await request(
        bestVariantUrl.includes('/') ? bestVariantUrl : `${baseURL}/${bestVariantUrl}`,
        {
          responseType: 'text',
        }
      );
    } else {
      baseURL = bestVariantUrl.substring(0, bestVariantUrl.lastIndexOf('/'));

      variantM3u8String = await request(bestVariantUrl, { responseType: 'text' });
    }

    return { variantM3u8String, baseURL };
  } catch (error: unknown) {
    log.error(createErrorContext(error, { vodId }), 'Failed to get Twitch HLS playlist');

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
  log: AppLogger,
  retryCount: number,
  maxRetryBeforeEndDetection: number,
  session?: CycleTLSSession
): Promise<FetchPlaylistResult | null> {
  const fetchUrl = sourceUrl || '';

  if (!fetchUrl) {
    log.error({ vodId }, 'No Kick HLS source URL provided. Cannot continue download.');

    await sleep(5000);

    if (retryCount > maxRetryBeforeEndDetection * 2) {
      log.error({ vodId }, 'Aborting download - no source URL available after multiple attempts');
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
    log.error(createErrorContext(error, { vodId }), 'Failed to fetch Kick HLS playlist');

    await sleep(5000 * Math.min(retryCount, 6));

    if (retryCount > maxRetryBeforeEndDetection) {
      log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
      return null;
    }

    return null;
  }
}
