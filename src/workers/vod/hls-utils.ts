import { extractErrorDetails } from '../../utils/error.js';
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { pipeline } from 'stream/promises';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import pLimit from 'p-limit';
import type { AppLogger } from '../../utils/logger.js';
import { fileExists } from '../../utils/path.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch/index.js';
import { request, segmentDownloadAgent } from '../../utils/http-client.js';
import { PLATFORMS } from '../../types/platforms.js';

export type DownloadStrategy = { type: 'fetch'; signal?: AbortSignal } | { type: 'cycletls'; session: CycleTLSSession };

export function resolveDownloadStrategy(
  platform: typeof PLATFORMS.KICK | typeof PLATFORMS.TWITCH,
  cycleTLS: CycleTLSSession | null
): DownloadStrategy {
  return platform === PLATFORMS.KICK && cycleTLS ? { type: 'cycletls', session: cycleTLS } : { type: 'fetch' };
}

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
  onBatchComplete?: (completedCount: number, totalSegments: number) => void
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
      if (isAborted() === true) {
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
          if (isAborted() === true) {
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
            await pipeline(response.body, writer);
          } else {
            await strategy.session.streamToFile(`${baseURL}/${segment.uri}`, tempPath, {
              attempts: retryAttempts,
            });
          }
        });

        await fs.promises.rename(tempPath, outputPath);
        completedCount++;

        log.debug({ uri: segment.uri, current: completedCount, total: totalSegments }, `Segment downloaded`);
      } catch (error: unknown) {
        if (isAborted() === true) {
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

  if (isAborted() !== true) {
    log.debug({ total: totalSegments }, `All segments downloaded successfully`);
    if (onBatchComplete) {
      onBatchComplete(completedCount, totalSegments);
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
  tenantId?: string,
  retryOptions?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<FetchPlaylistResult> {
  const tokenSig = await getVodTokenSig(vodId, tenantId);

  const masterPlaylistContent = await getTwitchM3u8(String(vodId), tokenSig.value, tokenSig.signature, retryOptions);

  if (masterPlaylistContent == null || masterPlaylistContent === '') {
    log.error({ vodId }, 'Failed to fetch Twitch master playlist');
    throw new Error('Empty Twitch master playlist');
  }

  const parsedMaster: HLS.types.MasterPlaylist | HLS.types.MediaPlaylist = HLS.parse(masterPlaylistContent);

  if (parsedMaster == null) {
    log.error({ vodId }, 'Failed to parse Twitch master playlist');
    throw new Error('Failed to parse Twitch master playlist');
  }

  const bestVariantUrl = (parsedMaster as HLS.types.MasterPlaylist).variants?.[0]?.uri;

  if (bestVariantUrl == null || bestVariantUrl === '') {
    log.error({ vodId }, 'No variant URL found in master playlist');
    throw new Error('No variant URL found in master playlist');
  }

  let baseURL: string = '';
  let variantM3u8String: string = '';

  baseURL = bestVariantUrl.substring(0, bestVariantUrl.lastIndexOf('/'));
  variantM3u8String = await request(bestVariantUrl, { responseType: 'text', retryOptions });

  return { variantM3u8String, baseURL };
}

export async function fetchKickPlaylist(
  vodId: string,
  sourceUrl: string | undefined,
  log: AppLogger,
  session?: CycleTLSSession
): Promise<FetchPlaylistResult> {
  const fetchUrl = sourceUrl;

  if (fetchUrl == null || fetchUrl === '') {
    log.error({ vodId }, 'No Kick HLS source URL provided. Cannot continue download.');
    throw new Error('No Kick HLS source URL provided');
  }

  let baseURL: string = '';

  const tempSession = session ?? createSession();

  try {
    if (fetchUrl.includes('master.m3u8')) {
      const baseEndpoint = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
      baseURL = `${baseEndpoint}/1080p60`;

      const variantM3u8String = await tempSession.fetchText(`${baseURL}/playlist.m3u8`);

      return { variantM3u8String, baseURL };
    } else {
      const response = await tempSession.fetchText(fetchUrl);

      baseURL = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));

      return { variantM3u8String: response, baseURL };
    }
  } finally {
    if (!session) {
      tempSession.close();
    }
  }
}
