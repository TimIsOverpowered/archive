import fsPromises from 'fs/promises';
import { extractErrorDetails, createErrorContext, throwOnHttpError } from '../../utils/error.js';
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getTenantConfig } from '../../config/loader';
import { getClient } from '../../db/client';
import { sendRichAlert, updateDiscordEmbed, resetFailures, isAlertsEnabled } from '../../utils/discord-alerts.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch';
import { createAutoLogger as loggerWithTenant } from '../../utils/auto-tenant-logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import pLimit from 'p-limit';
import { updateChapterDuringDownload, finalizeKickChapters } from '../../services/kick.js';
import { saveVodChapters as saveTwitchVodChapters } from '../../services/twitch.js';
import { fileExists } from '../../utils/path.js';

export interface HlsDownloadOptions {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  uploadAfterDownload?: boolean;
  uploadMode?: 'vod' | 'all';
}

/**
 * Download a single segment (universal - handles both .ts and .mp4)
 * Uses standard fetch for Twitch
 */
async function downloadSegment(segmentUri: string, vodDir: string, baseURL: string, retryAttempts: number = 3): Promise<void> {
  const url = `${baseURL}/${segmentUri}`;
  const outputPath = pathMod.join(vodDir, segmentUri);
  const tempPath = outputPath + '.tmp';

  const exists = await fileExists(outputPath);

  if (exists) {
    return;
  }

  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const response = await fetch(url);
      lastResponse = response;

      throwOnHttpError(response, `Download segment ${url} (attempt ${attempt}/${retryAttempts})`);

      const writer = fs.createWriteStream(tempPath);
      const nodeWebStream = response.body as unknown as NodeWebStream<Uint8Array>;

      await pipeline(Readable.fromWeb(nodeWebStream), writer);

      await fsPromises.rename(tempPath, outputPath);
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      try {
        await fsPromises.unlink(tempPath).catch(() => {});
      } catch {}

      if (lastResponse && lastResponse.status >= 400 && lastResponse.status < 500) {
        break;
      }
    }
  }

  throw lastError ?? new Error('Unknown error downloading segment');
}

/**
 * Download segments in parallel using p-limit for concurrency control
 * Universal function - works with both .ts and .mp4 (fMP4) segments
 */
async function downloadSegmentsParallel(
  segments: HLS.types.Segment[],
  vodDir: string,
  baseURL: string,
  concurrency: number,
  retryAttempts: number,
  log: ReturnType<typeof loggerWithTenant>
): Promise<void> {
  const limit = pLimit(concurrency);
  let completedCount = 0;
  const totalSegments = segments.length;

  log.info({ count: totalSegments, concurrency, retryAttempts }, `Starting parallel segment download`);

  await Promise.all(
    segments.map(async (segment) => {
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          await limit(() => downloadSegment(segment.uri, vodDir, baseURL, 1));

          completedCount++;
          const progress = Math.round((completedCount / totalSegments) * 100);

          if (progress % 10 === 0 || completedCount === totalSegments) {
            log.debug({ current: completedCount, total: totalSegments, progress }, `Download progress: ${progress}%`);
          }
          return;
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));
          log.debug({ uri: segment.uri, attempt, error: lastError.message }, `Failed to download segment`);
        }
      }

      throw lastError;
    })
  );

  log.info({ total: totalSegments }, `All segments downloaded successfully`);
}

/**
 * Download segments using CycleTLS for Kick platform
 * Parallel version with concurrency control
 */
async function downloadKickSegmentsParallel(
  segmentUris: string[],
  vodDir: string,
  baseURL: string,
  session: CycleTLSSession,
  concurrency: number,
  retryAttempts: number,
  log: ReturnType<typeof loggerWithTenant>
): Promise<void> {
  const limit = pLimit(concurrency);
  let completedCount = 0;
  const totalSegments = segmentUris.length;

  log.info({ count: totalSegments, concurrency, retryAttempts }, `Starting parallel Kick segment download (CycleTLS)`);

  await Promise.all(
    segmentUris.map(async (uri) => {
      const outputPath = pathMod.join(vodDir, uri);
      const tempPath = outputPath + '.tmp';

      const exists = await fileExists(outputPath);

      if (exists) {
        completedCount++;
        return;
      }

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          await limit(() => session.streamToFile(`${baseURL}/${uri}`, tempPath));

          await fsPromises.rename(tempPath, outputPath);

          completedCount++;
          const progress = Math.round((completedCount / totalSegments) * 100);

          if (progress % 10 === 0 || completedCount === totalSegments) {
            log.debug({ current: completedCount, total: totalSegments, progress }, `Kick download progress: ${progress}%`);
          }
          return;
        } catch (error: unknown) {
          lastError = error instanceof Error ? error : new Error(String(error));

          try {
            await fsPromises.unlink(tempPath).catch(() => {});
          } catch {}

          log.debug({ uri, attempt, error: lastError.message }, `Failed to download Kick segment`);
        }
      }

      throw lastError;
    })
  );

  log.info({ total: totalSegments }, `All Kick segments downloaded successfully`);
}

export async function cleanupOrphanedTmpFiles(vodDir: string, log: ReturnType<typeof loggerWithTenant>): Promise<void> {
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

function updateAlertProgress(messageId: string | null, platform: string, totalSegmentsFound: number, vodId: string, startedAt?: string): void {
  if (!messageId || !isAlertsEnabled()) return;

  // Calculate elapsed time
  const startTime = startedAt ? new Date(startedAt) : new Date();
  const elapsedSeconds = Math.floor((Date.now() - startTime.getTime()) / 1000);

  // Format as HH:MM:SS
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedFormatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const fields = [
    { name: 'Platform', value: platform, inline: true },
    { name: 'Segments', value: String(totalSegmentsFound), inline: true },
    { name: 'Elapsed Time', value: elapsedFormatted, inline: false },
  ];

  updateDiscordEmbed(messageId, {
    title: `📥 Downloading ${vodId}`,
    description: `${platform.toUpperCase()} live HLS download in progress`,
    status: 'warning',
    fields,
    timestamp: startTime.toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });
}

async function fetchTwitchPlaylist(
  vodId: string,
  log: ReturnType<typeof loggerWithTenant>,
  retryCount: number,
  maxRetryBeforeEndDetection: number
): Promise<{ variantM3u8String: string; baseURL: string } | null> {
  const tokenSig = await getVodTokenSig(vodId);

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

async function fetchKickPlaylist(
  vodId: string,
  sourceUrl: string | undefined,
  log: ReturnType<typeof loggerWithTenant>,
  retryCount: number,
  maxRetryBeforeEndDetection: number,
  session?: CycleTLSSession
): Promise<{ variantM3u8String: string; baseURL: string } | null> {
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

export async function downloadLiveHls(options: HlsDownloadOptions): Promise<{ success: true; finalPath: string; durationSeconds?: number }> {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = options;

  const log = loggerWithTenant(tenantId);

  log.info(
    {
      dbId,
      vodId,
      platform,
      tenantId,
      platformUserId,
      platformUsername,
      startedAt,
      hasSourceUrl: !!sourceUrl,
    },
    `[HLS-Downloader] Starting Live HLS Download mode for ${platform} stream`
  );
  const streamerClient = getClient(tenantId);
  try {
    if (!streamerClient) throw new Error('Streamer database client not available');

    const vodRecord = await streamerClient.vod.findUnique({ where: { id: dbId } });

    if (!vodRecord || !vodRecord.id) throw new Error(`VOD record not found for ${vodId}`);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.error({ ...details, vodId }, `[${vodId}] Failed to get database connection`);
    throw error;
  }

  const config = getTenantConfig(tenantId);

  if (!config) {
    log.error({ vodId, tenantId, platform }, `[HLS-Downloader] CRITICAL - Stream config not found. Cannot proceed with download.`);
    throw new Error(`Stream config not found for VOD ${vodId} (tenantId: ${tenantId})`);
  }

  log.debug({ vodId, tenantId, vodPath: config.settings.vodPath }, `[HLS-Downloader] Configuration loaded successfully`);

  // Initialize alert state
  let messageId: string | null = null;

  if (isAlertsEnabled()) {
    try {
      const startTime = new Date().toISOString();

      messageId = await sendRichAlert({
        title: `[HLS] Live Stream Started: ${vodId}`,
        description: `${platform.toUpperCase()} live HLS download in progress`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Tenant ID', value: tenantId, inline: true },
          { name: 'Started At', value: startedAt || startTime, inline: false },
        ],
        timestamp: startTime,
      });
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn(`Failed to initialize Discord alert: ${details.message}`);
    }
  }

  const basePath = config.settings.livePath || config.settings.vodPath || '';
  const vodDir = pathMod.join(basePath, tenantId, String(vodId));

  try {
    await fsPromises.mkdir(vodDir, { recursive: true });
    log.info(`[${vodId}] Created download directory: ${vodDir}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`Failed to create VOD directory ${vodDir}: ${(error as Error).message}`);
    }
  }

  const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);

  let retryCount = 0;
  const maxRetryBeforeEndDetection = 12;
  let lastSegmentUri: string | null = null;
  let noChangePollCounter = 0;
  let baseURL: string = '';
  let totalSegmentsFound = 0;

  // Create persistent CycleTLS session for Kick downloads
  let kickSession: CycleTLSSession | null = null;

  if (platform === 'kick') {
    kickSession = createSession();
    log.info(`[${vodId}] Created CycleTLS session for Kick HLS download`);
  }

  log.info(`[${vodId}] Starting HLS polling loop...`);

  while (true) {
    try {
      const filesInDir = await fsPromises.readdir(vodDir);

      const mp4Segments = filesInDir.filter((f) => f.endsWith('.mp4'));
      const tsSegments = filesInDir.filter((f) => f.endsWith('.ts'));
      const segmentCount = mp4Segments.length || tsSegments.length;

      if (segmentCount > totalSegmentsFound && isAlertsEnabled() && messageId) {
        totalSegmentsFound = segmentCount;

        updateAlertProgress(messageId, platform, totalSegmentsFound, vodId, startedAt);

        log.debug({ vodId, newSegmentCount: totalSegmentsFound }, `[HLS-Downloader] Detected ${totalSegmentsFound} TS segments on disk`);
      }

      log.trace({ vodId, retryCount: retryCount + 1 }, `Polling HLS playlist (attempt #${retryCount + 1})...`);

      let variantM3u8String: string = '';
      let fetchedBaseURL: string = '';

      if (platform === 'twitch') {
        const result = await fetchTwitchPlaylist(vodId, log, retryCount, maxRetryBeforeEndDetection);

        if (!result) {
          retryCount++;
          await sleep(getRetryDelay(retryCount));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      } else if (platform === 'kick') {
        const result = await fetchKickPlaylist(vodId, sourceUrl, log, retryCount, maxRetryBeforeEndDetection, kickSession ?? undefined);

        if (!result) {
          retryCount++;
          await sleep(getRetryDelay(retryCount));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      }

      const parsedM3u8: HLS.types.MasterPlaylist | HLS.types.MediaPlaylist = HLS.parse(variantM3u8String);

      if (!parsedM3u8) {
        log.error(`[${vodId}] Invalid HLS playlist structure`);

        retryCount++;
        await sleep(60000);
        continue;
      }

      baseURL = fetchedBaseURL;
      const segments: HLS.types.Segment[] = (parsedM3u8 as HLS.types.MediaPlaylist).segments || [];
      const currentLastSegment = segments?.[segments.length - 1]?.uri || '';

      if (lastSegmentUri === currentLastSegment && lastSegmentUri !== null) {
        noChangePollCounter++;

        log.info(`[${vodId}] No new segments detected. Poll #${noChangePollCounter} without change.`);

        const maxNoChangeThreshold = 5; // 5 polls * 60s = ~300 seconds (5 minutes) for stream end detection

        if (noChangePollCounter >= maxNoChangeThreshold) {
          log.info(`[${vodId}] Stream end detected after ${noChangePollCounter} unchanged polls (${noChangePollCounter * 60}s)`);

          break; // Exit polling loop - assume stream has ended naturally or platform stopped sending updates
        }
      } else {
        if (noChangePollCounter > 0) {
          log.info(`[${vodId}] New segment detected. Resuming download after ${noChangePollCounter} idle polls.`);
        }

        lastSegmentUri = currentLastSegment;
        noChangePollCounter = 0;
      }

      await fsPromises.writeFile(m3u8Path, variantM3u8String);

      log.debug(`[${vodId}] Playlist written. Total segments so far: ${segments.length}`);

      const newSegments = segments.filter((seg) => !fs.existsSync(pathMod.join(vodDir, seg.uri)));

      if (newSegments.length > 0) {
        log.info(`[${vodId}] Found ${newSegments.length} new segments to download...`);

        const concurrency = 3;
        const retryAttempts = 3;

        try {
          if (platform === 'kick' && kickSession) {
            const segmentUris = newSegments.map((seg) => seg.uri);

            await downloadKickSegmentsParallel(segmentUris, vodDir, baseURL, kickSession!, concurrency, retryAttempts, log);
          } else {
            await downloadSegmentsParallel(newSegments, vodDir, baseURL, concurrency, retryAttempts, log);
          }
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.error({ ...details, vodId }, `[${vodId}] Error downloading segments`);

          retryCount++;

          if (retryCount > maxRetryBeforeEndDetection) {
            throw new Error('Segment download failed after multiple retries');
          }

          await sleep(getRetryDelay(retryCount));

          continue;
        }
      } else {
        log.debug(`[${vodId}] No new segments. Last segment: ${currentLastSegment}`);
      }

      retryCount = 0;

      if (platform === 'kick' && streamerClient) {
        await updateChapterDuringDownload(dbId, vodId, tenantId, streamerClient);
      }

      await sleep(60000); // Poll every 60 seconds for VOD downloads
    } catch (error: unknown) {
      const details = extractErrorDetails(error);
      log.error({ ...details, vodId }, `[${vodId}] Error in HLS poll cycle`);

      retryCount++;

      await sleep(getRetryDelay(retryCount));

      if (retryCount > maxRetryBeforeEndDetection) {
        // Higher threshold for complete failures vs just no segments
        log.error(`[${vodId}] Aborting live HLS download after ${retryCount} consecutive errors`);

        throw new Error('Live HLS polling failed repeatedly');
      }

      continue;
    }
  }

  if (isAlertsEnabled() && messageId) {
    updateDiscordEmbed(messageId, {
      title: `[HLS] Converting ${vodId}`,
      description: 'Download complete. MP4 conversion in progress...',
      status: 'warning',
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Total Segments', value: String(totalSegmentsFound), inline: false },
      ],
      timestamp: startedAt || new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    });
  }

  log.info({ vodId, platform, totalSegmentsDownloaded: totalSegmentsFound }, `[HLS-Downloader] Stream download complete. Starting finalization and MP4 conversion...`);

  try {
    const filesInDir = await fsPromises.readdir(vodDir);

    // Detect segment format: fMP4 vs traditional TS HLS
    const hasInitSegment = filesInDir.some((f) => f.includes('init') && f.endsWith('.mp4'));
    const mp4Segments = filesInDir.filter((f) => f.endsWith('.mp4'));
    const tsSegments = filesInDir.filter((f) => f.endsWith('.ts'));

    const finalMp4Path = pathMod.join(basePath, tenantId, `${vodId}.mp4`);

    if (hasInitSegment && mp4Segments.length > 0) {
      log.info(`[${vodId}] Detected fMP4 segments (${mp4Segments.length} files).`);

      const { convertHlsToMp4 } = await import('../../utils/ffmpeg.js');

      await convertHlsToMp4(m3u8Path, finalMp4Path, { vodId, isFmp4: true });

      log.info(`[${vodId}] fMP4 merging complete. File saved to ${finalMp4Path}`);
    } else if (tsSegments.length > 0) {
      const tsFilesCount = tsSegments.length;

      log.info(`[${vodId}] Found ${tsFilesCount} TS segments. Starting MP4 conversion...`);

      const { convertHlsToMp4 } = await import('../../utils/ffmpeg.js');

      await convertHlsToMp4(m3u8Path, finalMp4Path, { vodId, isFmp4: false });

      log.info(`[${vodId}] MP4 conversion complete. File saved to ${finalMp4Path}`);
    } else {
      throw new Error(`No valid segments found in ${vodDir}. Download may have failed or stream was empty.`);
    }

    const { getDuration } = await import('../../utils/ffmpeg.js');

    const actualDuration = await getDuration(finalMp4Path);

    if (actualDuration) {
      const formattedDuration = toHHMMSS(Math.round(actualDuration));
      const durationSeconds = Math.round(actualDuration);

      if (platform === 'kick') {
        await finalizeKickChapters(dbId, vodId, durationSeconds, streamerClient);
      } else if (platform === 'twitch') {
        await saveTwitchVodChapters(dbId, vodId, tenantId, durationSeconds, streamerClient);
      }

      await streamerClient.vod.update({ where: { id: dbId }, data: { duration: durationSeconds, is_live: false } });

      log.info(`[${vodId}] Updated VOD with duration ${formattedDuration} and marked as ended`);

      if (isAlertsEnabled() && messageId) {
        updateDiscordEmbed(messageId, {
          title: `[HLS] ${vodId} Complete!`,
          description: `${platform.toUpperCase()} live stream successfully processed and converted to MP4`,
          status: 'success',
          fields: [
            { name: 'Platform', value: platform, inline: true },
            { name: 'Duration', value: formattedDuration, inline: false },
          ],
          timestamp: startedAt || new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      }

      if (options.uploadAfterDownload) {
        try {
          const { queueYoutubeUpload } = await import('../../utils/upload-queue.js');

          await queueYoutubeUpload(options.tenantId, options.dbId, options.vodId, finalMp4Path, options.uploadMode || 'all', options.platform, log);

          log.info({ vodId }, `Upload job(s) queued after HLS download completion`);
        } catch (error) {
          const details = extractErrorDetails(error);
          log.warn({ ...details, vodId }, `Failed to queue upload job after HLS download`);
        }
      }

      return { success: true as const, finalPath: finalMp4Path, durationSeconds: actualDuration };
    } else {
      log.warn(`[${vodId}] Could not determine video duration from MP4 file`);
      await streamerClient.vod.update({ where: { id: dbId }, data: { is_live: false } });

      return { success: true as const, finalPath: finalMp4Path };
    }
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.error({ ...details, vodId }, `[${vodId}] Finalization failed`);

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `[HLS] ${vodId} FAILED`,
        description: `${platform.toUpperCase()} live stream processing failed`,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Error', value: (error as Error).message.substring(0, 500), inline: false },
        ],
        timestamp: startedAt || new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  } finally {
    // Close CycleTLS session for Kick downloads
    if (kickSession) {
      await kickSession.close();
      log.info(`[${vodId}] Closed CycleTLS session`);
    }

    const finalMp4Path = pathMod.join(basePath, tenantId, `${vodId}.mp4`);

    const exists = await fileExists(finalMp4Path);

    if (exists) {
      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
          resetFailures(tenantId);

          log.info({ vodId }, `Cleaned up temporary directory ${vodDir}`);
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.warn({ ...details, vodId }, `Failed to clean up temporary directory`);
        }
      } else {
        resetFailures(tenantId);

        log.info({ vodId }, `HLS files preserved in ${vodDir} (saveHLS=true)`);
      }
    } else {
      const details = extractErrorDetails(new Error('Final MP4 file not found'));
      log.error({ ...details, vodId }, `Final MP4 file not found`);

      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.warn({ ...details, vodId }, `Cleanup failed`);
        }
      }
    }
  }
}

export default downloadLiveHls;
