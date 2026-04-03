import fsPromises from 'fs/promises';
import { extractErrorDetails, createErrorContext } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'hls-downloader' });
import fs from 'fs';
import pathMod from 'path';
import HLS from 'hls-parser';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { getStreamerConfig } from '../../config/loader';
import { getClient } from '../../db/client';
import { sendRichAlert, updateDiscordEmbed, resetFailures, isAlertsEnabled } from '../../utils/discord-alerts.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch';
import { loggerWithTenant } from '../../utils/logger.js';
import { createSession, type CycleTLSSession } from '../../utils/cycletls.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import Redis from 'ioredis';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { updateChapterDuringDownload, finalizeKickChapters } from '../../services/kick.js';
import { saveVodChapters as saveTwitchVodChapters } from '../../services/twitch.js';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export interface HlsDownloadOptions {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string;
  sourceUrl?: string;
}

async function downloadTSSegment(segmentUri: string, vodDir: string, baseURL: string): Promise<void> {
  const url = `${baseURL}/${segmentUri}`;
  const outputPath = pathMod.join(vodDir, segmentUri);
  const tempPath = outputPath + '.tmp';

  try {
    const response = await fetch(url);

    if (!response.ok || !response.body) {
      throw new Error(`Failed to download segment ${url}: status ${response.status}`);
    }

    const writer = fs.createWriteStream(tempPath);

    const nodeWebStream = response.body as unknown as NodeWebStream<Uint8Array>;

    await pipeline(Readable.fromWeb(nodeWebStream), writer);

    await fsPromises.rename(tempPath, outputPath);
  } catch (error: unknown) {
    try {
      await fsPromises.unlink(tempPath).catch(() => {});
    } catch {}
    throw error;
  }
}

/**
 * Download TS segments sequentially using CycleTLS for Kick platform
 */
async function downloadKickSegmentsWithCycleTLS(segmentUris: string[], vodDir: string, baseURL: string, session: CycleTLSSession, log: ReturnType<typeof loggerWithTenant>): Promise<void> {
  for (const uri of segmentUris) {
    const outputPath = pathMod.join(vodDir, uri);
    const tempPath = outputPath + '.tmp';

    try {
      await fsPromises.access(outputPath); // Check if exists
      continue; // Skip existing files
    } catch {
      // File does not exist, continue to download
    }

    const url = `${baseURL}/${uri}`;

    await session.streamToFile(url, tempPath);

    try {
      await fsPromises.rename(tempPath, outputPath);
    } catch (error) {
      await fsPromises.unlink(tempPath).catch(() => {});
      throw error;
    }

    log.debug({ uri }, `Downloaded ${uri}`);
  }

  if (segmentUris.length > 0) {
    log.info(`Done downloading.. Last segment was ${segmentUris[segmentUris.length - 1]}`);
  }
}

async function downloadTSSegmentsSequentially(segments: HLS.types.Segment[], vodDir: string, baseURL: string): Promise<void> {
  for (const segment of segments) {
    const outputPath = pathMod.join(vodDir, segment.uri);

    try {
      await fsPromises.access(outputPath);
      continue; // File exists - skip download
    } catch {
      await downloadTSSegment(segment.uri, vodDir, baseURL);
    }
  }
}

/**
 * Scan directory for existing segments from crash recovery scenario
 * Returns count and highest segment filename found (for logging)
 */
export async function recoverPartialDownload(vodDir: string, log: ReturnType<typeof loggerWithTenant>): Promise<{ lastCompleteSegment?: string; totalSegments: number }> {
  try {
    const files = await fsPromises.readdir(vodDir);

    // Scan for .ts OR .mp4 segments ONLY (exclude final merged output file)
    const tsSegments = files.filter((f) => f.endsWith('.ts'));
    const mp4Segments = files.filter(
      (f) => f.endsWith('.mp4') && !f.includes('_final.mp4') // Exclude merged output file if exists
    );

    const totalSegments = Math.max(tsSegments.length, mp4Segments.length);

    // Find highest-numbered segment for logging purposes (optional)
    let lastCompleteSegment: string | undefined;

    if (tsSegments.length > 0 && tsSegments[0]) {
      lastCompleteSegment = tsSegments[tsSegments.length - 1];
    } else if (mp4Segments.length > 0 && mp4Segments[0]) {
      lastCompleteSegment = mp4Segments[mp4Segments.length - 1];
    }

    return {
      totalSegments,
      lastCompleteSegment: lastCompleteSegment || undefined,
    };
  } catch (error) {
    log.warn({ error: extractErrorDetails(error).message }, `Failed to scan directory for recovery`);
    return { totalSegments: 0 };
  }
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

/**
 * Check if partial download exists by scanning for segments on disk
 */
export async function checkForPartialDownload(vodDir: string): Promise<boolean> {
  try {
    const files = await fsPromises.readdir(vodDir);

    // Check for any .ts or .mp4 segments (excluding final merged output)
    return files.some((f) => f.endsWith('.ts') || (f.endsWith('.mp4') && !f.includes('_final.mp4')));
  } catch {
    // Directory doesn't exist - no partial download
    return false;
  }
}

async function cleanupVodProgress(vodId: string): Promise<void> {
  try {
    const key = `vod_progress:${vodId}`;

    await redis.del(key);
  } catch (error) {
    log.warn(createErrorContext(error, { vodId }), `Failed to cleanup VOD progress in Redis`);
  }
}

function updateAlertProgress(messageId: string | null, platform: string, totalSegmentsFound: number, vodId: string, startedAt?: string): void {
  if (!messageId || !isAlertsEnabled()) return;

  const fields = [
    { name: 'Platform', value: platform, inline: true },
    { name: 'Segments', value: String(totalSegmentsFound), inline: false },
  ];

  if (totalSegmentsFound > 20 && totalSegmentsFound < 40) {
    fields.push({ name: 'Progress', value: '~30%', inline: false });
  } else if (totalSegmentsFound > 45 && totalSegmentsFound < 80) {
    fields.push({ name: 'Progress', value: '~60%', inline: false });
  } else if (totalSegmentsFound > 150) {
    fields.push({ name: 'Progress', value: '~90%', inline: false });
  }

  updateDiscordEmbed(messageId, {
    title: `📥 Downloading ${vodId}`,
    description: `${platform.toUpperCase()} live HLS download in progress`,
    status: 'warning',
    fields,
    timestamp: startedAt || new Date().toISOString(),
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
    const masterPlaylistContent = await getTwitchM3u8(vodId, tokenSig.value, tokenSig.signature);

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
  session?: CycleTLSSession // Optional parameter for persistent sessions
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
  const { vodId, platform, streamerId, startedAt, sourceUrl } = options;

  const log = loggerWithTenant(String(streamerId));

  log.info(
    {
      vodId,
      platform,
      streamerId: String(streamerId),
      startedAt,
      hasSourceUrl: !!sourceUrl,
    },
    `[HLS-Downloader] Starting Live HLS Download mode for ${platform} stream`
  );
  const streamerClient = getClient(streamerId);
  try {
    if (!streamerClient) throw new Error('Streamer database client not available');

    const vodRecord = await streamerClient.vod.findUnique({ where: { id: vodId } });

    if (!vodRecord || !vodRecord.id) throw new Error(`VOD record not found for ${vodId}`);
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    log.error({ ...details, vodId }, `[${vodId}] Failed to get database connection`);
    throw error;
  }

  const config = getStreamerConfig(String(streamerId)) || getStreamerConfig(vodId.split('-')[0]);

  if (!config) {
    log.error({ vodId, streamerId: String(streamerId), platform }, `[HLS-Downloader] CRITICAL - Stream config not found. Cannot proceed with download.`);
    throw new Error(`Stream config not found for VOD ${vodId} (streamerId: ${String(streamerId)})`);
  }

  log.debug({ vodId, streamerId: String(streamerId), vodPath: config.settings.vodPath }, `[HLS-Downloader] Configuration loaded successfully`);

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
          { name: 'Streamer ID', value: String(streamerId), inline: true },
          { name: 'Started At', value: startedAt || startTime, inline: false },
        ],
        timestamp: startTime,
      });
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn(`Failed to initialize Discord alert: ${details.message}`);
    }
  }

  const vodDir = pathMod.join(config.settings.vodPath || '', String(streamerId), vodId);

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
          // Check if we should break or continue based on error type
          if (retryCount > maxRetryBeforeEndDetection) {
            // [OFFLINE AFTER CRASH] Check for crash recovery - partial segments exist?

            const hasExistingSegments = await checkForPartialDownload(vodDir);

            if (hasExistingSegments && totalSegmentsFound > 0) {
              log.warn({ vodId, segmentCount: totalSegmentsFound }, `[${vodId}] Stream ended but ${totalSegmentsFound} segments already downloaded. Attempting finalization...`);

              // Continue to MP4 conversion - don't throw error yet
              break; // Exit loop, proceed with existing data
            } else {
              log.error({ vodId }, `[${vodId}] No segments found and stream is offline. Failing job.`);
              await cleanupVodProgress(vodId);

              throw new Error('Stream ended before any segments were downloaded');
            }
          }

          retryCount++;
          await sleep(getRetryDelay(retryCount));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      } else if (platform === 'kick') {
        const result = await fetchKickPlaylist(vodId, sourceUrl, log, retryCount, maxRetryBeforeEndDetection, kickSession ?? undefined); // Pass persistent session

        if (!result) {
          // Special handling for Kick - may need to update DB on abort

          // [OFFLINE AFTER CRASH] Check before giving up completely
          if (retryCount > maxRetryBeforeEndDetection * 2 && !sourceUrl) {
            const hasExistingSegments = await checkForPartialDownload(vodDir);

            if (hasExistingSegments && totalSegmentsFound > 0) {
              log.warn({ vodId, segmentCount: totalSegmentsFound }, `[${vodId}] Stream ended but ${totalSegmentsFound} segments already downloaded. Attempting finalization...`);

              await streamerClient.vod.update({ where: { id: vodId }, data: { is_live: false } });
              break; // Exit loop, proceed with existing data
            } else {
              log.error({ vodId }, `[${vodId}] Kick HLS source URL not available and no segments downloaded`);

              await streamerClient.vod.update({ where: { id: vodId }, data: { is_live: false } });

              throw new Error('Kick HLS source URL not available');
            }
          }

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
        log.info(`[${vodId}] Found ${newSegments.length} new TS segments to download...`);

        try {
          if (platform === 'kick' && kickSession) {
            const segmentUris = newSegments.map((seg) => seg.uri);

            await downloadKickSegmentsWithCycleTLS(segmentUris, vodDir, baseURL, kickSession!, log);
          } else {
            await downloadTSSegmentsSequentially(newSegments, vodDir, baseURL);
          }
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.error({ ...details, vodId }, `[${vodId}] Error downloading segments`);

          retryCount++;

          if (retryCount > maxRetryBeforeEndDetection) {
            throw new Error('Segment download failed after multiple retries'); // Will trigger worker retry logic
          }

          await sleep(getRetryDelay(retryCount));

          continue; // Skip to next poll cycle without incrementing noChange counter (we still got playlist data)
        }
      } else {
        log.debug(`[${vodId}] No new segments. Last segment: ${currentLastSegment}`);
      }

      retryCount = 0;

      if (platform === 'kick' && streamerClient) {
        await updateChapterDuringDownload(vodId, streamerId, streamerClient);
      }

      await sleep(60000); // Poll every 60 seconds for VOD downloads
    } catch (error: unknown) {
      const details = extractErrorDetails(error);
      log.error({ ...details, vodId }, `[${vodId}] Error in HLS poll cycle`);

      retryCount++;

      await sleep(getRetryDelay(retryCount));

      if (retryCount > maxRetryBeforeEndDetection + 12) {
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

    const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(streamerId), `${vodId}.mp4`);

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
        await finalizeKickChapters(vodId, durationSeconds, streamerClient);
      } else if (platform === 'twitch') {
        await saveTwitchVodChapters(vodId, streamerId, durationSeconds, streamerClient);
      }

      await streamerClient.vod.update({ where: { id: vodId }, data: { duration: durationSeconds, is_live: false } });

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

      return { success: true as const, finalPath: finalMp4Path, durationSeconds: actualDuration };
    } else {
      log.warn(`[${vodId}] Could not determine video duration from MP4 file`);
      await streamerClient.vod.update({ where: { id: vodId }, data: { is_live: false } });

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

    const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(streamerId), `${vodId}.mp4`);

    try {
      await fsPromises.access(finalMp4Path);

      // Download completed successfully
      await cleanupVodProgress(vodId);

      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
          resetFailures(String(streamerId));

          log.info(`[${vodId}] Cleaned up temporary directory ${vodDir}`);
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.warn({ ...details, vodId }, `[${vodId}] Failed to clean up temporary directory`);
        }
      } else {
        resetFailures(String(streamerId));

        log.info(`[${vodId}] HLS files preserved in ${vodDir} (saveHLS=true)`);
      }
    } catch (error) {
      const details = extractErrorDetails(error);
      log.error({ ...details, vodId }, `[${vodId}] Final MP4 file not found`);

      // Download failed - cleanup progress but keep dedup lock for retry
      await cleanupVodProgress(vodId);

      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
        } catch (error: unknown) {
          const details = extractErrorDetails(error);
          log.warn({ ...details, vodId }, `[${vodId}] Cleanup failed`);
        }
      }
    }
  }
}

export default downloadLiveHls;
