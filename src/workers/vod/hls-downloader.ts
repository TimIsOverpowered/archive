import fsPromises from 'fs/promises';
import fs from 'fs';
import pathMod from 'path';
import axios from 'axios';
import HLS from 'hls-parser';
import { getStreamerConfig } from '../../config/loader';
import { getClient } from '../../db/client';
import { sendRichAlert, updateDiscordEmbed, resetFailures, isAlertsEnabled } from '../../utils/alerts';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../../services/twitch';
import { getYoutubeUploadQueue } from '../../jobs/queues';
import { convertHlsToMp4, getDuration as getVideoDuration } from '../../utils/video-utils';
import { createAutoLogger } from '../../utils/auto-tenant-logger';

export interface HlsDownloadOptions {
  vodId: string;
  platform: 'twitch' | 'kick';
  streamerId: string;
  startedAt?: string;
  sourceUrl?: string;
}

interface _AlertState {
  messageId: string | null;
  totalSegmentsFound: number;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toHHMMSS(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  return [hrs, mins, secs].map((v) => (v < 10 ? '0' + String(v) : String(v))).join(':');
}

async function downloadTSSegment(segmentUri: string, vodDir: string, baseURL: string): Promise<void> {
  const url = `${baseURL}/${segmentUri}`;
  const outputPath = pathMod.join(vodDir, segmentUri);

  try {
    const writer = fs.createWriteStream(outputPath);
    await axios({ method: 'get', url, responseType: 'stream' }).then((response) => response.data.pipe(writer));
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error: any) {
    throw error;
  }
}

async function downloadTSSegmentsSequentially(segments: any[], vodDir: string, baseURL: string): Promise<void> {
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

function updateAlertProgress(messageId: string | null, platform: string, totalSegmentsFound: number, vodId: string, startedAt?: string): void {
  if (!messageId || !isAlertsEnabled()) return;

  const _noChangePollCounter = Math.floor(totalSegmentsFound / 5); // Approximate based on segments

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
  log: ReturnType<typeof createAutoLogger>,
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

      await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));
      return null;
    }

    const parsedMaster: any = HLS.parse(masterPlaylistContent);

    if (!parsedMaster) {
      log.error(`[${vodId}] Failed to parse Twitch master playlist`);

      await new Promise((resolve) => setTimeout(resolve, 5000));
      return null;
    }

    const bestVariantUrl = parsedMaster.variants?.[0]?.uri || parsedMaster.uri;
    let baseURL: string = '';
    let variantM3u8String: string = '';

    if (!bestVariantUrl.startsWith('http')) {
      baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));
      variantM3u8String = await axios.get(bestVariantUrl.includes('/') ? bestVariantUrl : `${baseURL}/${bestVariantUrl}`).then((r) => r.data);
    } else {
      baseURL = bestVariantUrl.substring(0, bestVariantUrl.lastIndexOf('/'));
      variantM3u8String = await axios.get(bestVariantUrl).then((r) => r.data);
    }

    return { variantM3u8String, baseURL };
  } catch (error: any) {
    log.error(`[${vodId}] Failed to fetch Twitch HLS playlist:`, error.message);

    if (retryCount > maxRetryBeforeEndDetection) {
      log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));
    return null;
  }
}

async function fetchKickPlaylist(
  vodId: string,
  sourceUrl: string | undefined,
  log: ReturnType<typeof createAutoLogger>,
  retryCount: number,
  maxRetryBeforeEndDetection: number
): Promise<{ variantM3u8String: string; baseURL: string } | null> {
  const fetchUrl = sourceUrl || '';

  if (!fetchUrl) {
    log.error(`[${vodId}] No Kick HLS source URL provided. Cannot continue download.`);

    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (retryCount > maxRetryBeforeEndDetection * 2) {
      log.error(`[${vodId}] Aborting download - no source URL available after multiple attempts`);
      return null;
    }

    return null;
  }

  let baseURL: string = '';
  let variantM3u8String: string = '';

  try {
    if (fetchUrl.includes('master.m3u8')) {
      const baseEndpoint = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
      baseURL = `${baseEndpoint}/1080p60`;

      variantM3u8String = await axios.get(`${baseURL}/playlist.m3u8`).then((r) => r.data);
    } else {
      const response = await axios.get(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });

      baseURL = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
      variantM3u8String = response.data;
    }

    return { variantM3u8String, baseURL };
  } catch (error: any) {
    log.error(`[${vodId}] Failed to fetch Kick HLS playlist from ${fetchUrl}:`, error.message);

    await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

    if (retryCount > maxRetryBeforeEndDetection) {
      log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
      return null;
    }

    return null;
  }
}

export async function downloadLiveHls(options: HlsDownloadOptions): Promise<{ success: true; finalPath: string; durationSeconds?: number }> {
  const { vodId, platform, streamerId, startedAt, sourceUrl } = options;

  // Create logger with tenant context ONCE at start of processing scope
  const log = createAutoLogger(String(streamerId));

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

  let prisma: any;
  try {
    const metaClient = getClient('meta');

    if (!metaClient) throw new Error('Meta database client not available');

    const vodRecord = await metaClient.vod.findUnique({ where: { id: vodId } });

    if (!vodRecord || !vodRecord.id) throw new Error(`VOD record not found for ${vodId}`);

    prisma = getClient(String(streamerId));
  } catch (error: any) {
    log.error(`[${vodId}] Failed to get database connection:`, error.message);
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
    } catch {
      log.warn('Failed to initialize Discord alert message');
    }
  }

  const vodDir = pathMod.join(config.settings.vodPath || '', String(streamerId), vodId);

  try {
    await fsPromises.mkdir(vodDir, { recursive: true });
    log.info(`[${vodId}] Created download directory: ${vodDir}`);
  } catch (error: any) {
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

  log.info(`[${vodId}] Starting HLS polling loop...`);

  while (true) {
    try {
      const segmentCount = await fsPromises.readdir(vodDir).then((files) => files.filter((f) => f.endsWith('.ts')).length);

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
            break; // Exit loop - assume stream ended
          }

          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      } else if (platform === 'kick') {
        const result = await fetchKickPlaylist(vodId, sourceUrl, log, retryCount, maxRetryBeforeEndDetection);

        if (!result) {
          // Special handling for Kick - may need to update DB on abort
          if (retryCount > maxRetryBeforeEndDetection * 2 && !sourceUrl) {
            await prisma.vod.update({ where: { id: vodId }, data: { is_live: false, ended_at: new Date() } as any });

            throw new Error('Kick HLS source URL not available');
          }

          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));
          continue;
        }

        variantM3u8String = result.variantM3u8String;
        fetchedBaseURL = result.baseURL;
      }

      const parsedM3u8: any = HLS.parse(variantM3u8String);

      if (!parsedM3u8) {
        log.error(`[${vodId}] Invalid HLS playlist structure`);

        retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 5000));

        continue;
      }

      baseURL = fetchedBaseURL;
      const currentLastSegment = parsedM3u8.segments?.[parsedM3u8.segments.length - 1]?.uri || '';

      if (lastSegmentUri === currentLastSegment && lastSegmentUri !== null) {
        noChangePollCounter++;

        log.info(`[${vodId}] No new segments detected. Poll #${noChangePollCounter} without change.`);

        const maxNoChangeThreshold = 60; // 60 polls * 5s = ~300 seconds (5 minutes) for Kick stream end detection

        if (noChangePollCounter >= maxNoChangeThreshold) {
          log.info(`[${vodId}] Stream end detected after ${noChangePollCounter} unchanged polls (${noChangePollCounter * 5}s)`);

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

      log.debug(`[${vodId}] Playlist written. Total segments so far: ${parsedM3u8.segments?.length || 0}`);

      const newSegments = (parsedM3u8.segments || []).filter((seg: any) => !fileExists(`${vodDir}/${seg.uri}`));

      if (newSegments.length > 0) {
        log.info(`[${vodId}] Found ${newSegments.length} new TS segments to download...`);

        try {
          await downloadTSSegmentsSequentially(newSegments, vodDir, baseURL);
        } catch (error: any) {
          log.error(`[${vodId}] Error downloading segments:`, error.message);

          retryCount++;

          if (retryCount > maxRetryBeforeEndDetection) {
            throw new Error('Segment download failed after multiple retries'); // Will trigger worker retry logic
          }

          await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

          continue; // Skip to next poll cycle without incrementing noChange counter (we still got playlist data)
        }
      } else {
        log.debug(`[${vodId}] No new segments. Last segment: ${currentLastSegment}`);
      }

      retryCount = 0;

      await new Promise((resolve) => setTimeout(resolve, 5000)); // Poll every 5 seconds for live streams
    } catch (error: any) {
      log.error(`[${vodId}] Error in HLS poll cycle:`, error.message);

      retryCount++;

      await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

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
    const tsFilesCount = filesInDir.filter((f) => f.endsWith('.ts')).length;

    if (tsFilesCount === 0) throw new Error(`No TS segments found in ${vodDir}. Download may have failed or stream was empty.`);

    log.info(`[${vodId}] Found ${tsFilesCount} TS segments. Starting MP4 conversion...`);

    const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(streamerId), `${vodId}.mp4`);

    await convertHlsToMp4(m3u8Path, vodId, finalMp4Path);

    log.info(`[${vodId}] MP4 conversion complete. File saved to ${finalMp4Path}`);

    const actualDuration = await getVideoDuration(finalMp4Path);

    if (actualDuration) {
      const formattedDuration = toHHMMSS(Math.round(actualDuration));

      await prisma.vod.update({ where: { id: vodId }, data: { duration: formattedDuration, is_live: false, ended_at: new Date() } as any });

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
      await prisma.vod.update({ where: { id: vodId }, data: { is_live: false, ended_at: new Date() } as any });

      return { success: true as const, finalPath: finalMp4Path };
    }
  } catch (error: any) {
    log.error(`[${vodId}] Finalization failed:`, error.message);

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

    throw new Error('Stream finalization failed: ' + (error as Error).message);
  } finally {
    // Queue YouTube upload if configured
    const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(streamerId), `${vodId}.mp4`);

    try {
      await fsPromises.access(finalMp4Path);

      if (config.youtube) {
        const youtubeJob = {
          streamerId: String(streamerId),
          vodId,
          filePath: finalMp4Path,
          title: `Live Stream - ${vodId}`,
          description: '',
          type: 'vod' as const,
        };
        await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube:${vodId}` });
        log.info(`[${vodId}] YouTube upload job queued`);
      }

      // Cleanup temporary directory if not configured to save HLS files
      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
          resetFailures(String(streamerId));

          log.info(`[${vodId}] Cleaned up temporary directory ${vodDir}`);
        } catch (error: any) {
          // Non-critical cleanup failure - still mark as success but warn about cleanup issue
          log.warn(`[${vodId}] Failed to clean up temporary directory ${vodDir}:`, error.message);
        }
      } else {
        resetFailures(String(streamerId));

        log.info(`[${vodId}] HLS files preserved in ${vodDir} (saveHLS=true)`);
      }
    } catch {
      // File doesn't exist - this shouldn't happen but handle gracefully
      log.error(`[${vodId}] Final MP4 file not found at expected path: ${finalMp4Path}`);

      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
        } catch (error: any) {
          log.warn(`[${vodId}] Failed to clean up temporary directory during error handling:`, error.message);
        }
      }

      // Don't reset failures since the job didn't fully succeed
    }
  }
}
