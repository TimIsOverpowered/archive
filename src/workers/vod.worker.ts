import { Processor, Job } from 'bullmq';
import fsPromises from 'fs/promises';
import fs from 'fs';
import pathMod from 'path';
import axios from 'axios';
import HLS from 'hls-parser';
import Redis from 'ioredis';
import { getStreamerConfig } from '../config/loader.js';
import { getClient } from '../db/client.js';
import { sendDiscordAlert, updateDiscordMessage, resetFailures, isAlertsEnabled } from '../utils/alerts.js';
import { getVodTokenSig, getM3u8 as getTwitchM3u8 } from '../services/twitch.js';
import { getYoutubeUploadQueue } from '../jobs/queues.js';
import { convertHlsToMp4, getDuration as getVideoDuration } from '../utils/video-utils.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

interface LiveHlsDownloadJobData {
  vodId: string;
  platform: 'twitch' | 'kick';
  userId: string;
  startedAt?: string;
  sourceUrl?: string;
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function clearVodDedupKey(vodId: string): Promise<void> {
  try {
    const dedupKey = `vod_download:${vodId}`;
    await redis.del(dedupKey);
    console.info(`[${vodId}] Cleared Redis deduplication key for re-download`);
  } catch (error) {
    console.warn('Failed to clear dedup key:', error instanceof Error ? error.message : String(error));
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toHHMMSS(seconds: number): string {
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
    console.error(`Failed to download segment ${segmentUri}:`, error.message);
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

async function processLiveHlsDownload(job: Job<LiveHlsDownloadJobData>): Promise<any> {
  const { vodId, platform, userId, startedAt, sourceUrl } = job.data;

  // Create logger with tenant context ONCE at start of processing scope
  const log = createAutoLogger({
    tenantId: String(userId),
    component: 'VOD-Worker',
  });

  log.info(`[${vodId}] Starting Live HLS Download mode for ${platform} stream`);

  let prisma: any;
  try {
    const metaClient = getClient('meta');

    if (!metaClient) throw new Error('Meta database client not available');

    const vodRecord = await metaClient.vod.findUnique({ where: { id: vodId } });

    if (!vodRecord || !vodRecord.id) throw new Error(`VOD record not found for ${vodId}`);

    prisma = getClient(String(userId));
  } catch (error: any) {
    log.error(`[${vodId}] Failed to get database connection:`, error.message);
    throw error;
  }

  const config = getStreamerConfig(String(userId)) || getStreamerConfig(vodId.split('-')[0]);

  if (!config) throw new Error(`Stream config not found for VOD ${vodId}`);

  let messageId: string | null = null;

  if (isAlertsEnabled()) {
    try {
      messageId = await sendDiscordAlert(`[Live Stream] Starting live HLS download for VOD: ${vodId}\nStream started at: ${startedAt || 'Unknown'}`);
    } catch {
      log.warn('Failed to initialize Discord alert message');
    }

    const vodDir = pathMod.join(config.settings.vodPath || '', String(userId), vodId);

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

    log.info(`[${vodId}] Starting HLS polling loop...`);

    while (true) {
      try {
        if (isAlertsEnabled() && messageId && noChangePollCounter % 12 === 0) {
          const segmentCount = await fsPromises.readdir(vodDir).then((files) => files.filter((f) => f.endsWith('.ts')).length);
          await updateDiscordMessage(messageId, `[Live Stream] ${vodId} - Downloading segments... (${segmentCount} TS files so far)`);
        }

        log.info(`[${vodId}] Polling HLS playlist (attempt #${retryCount + 1})...`);

        let variantM3u8String = '';

        if (platform === 'twitch') {
          const tokenSig = await getVodTokenSig(vodId);

          try {
            const masterPlaylistContent = await getTwitchM3u8(vodId, tokenSig.value, tokenSig.signature);

            if (!masterPlaylistContent) {
              log.error(`[${vodId}] Failed to fetch Twitch master playlist`);

              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

              if (retryCount > maxRetryBeforeEndDetection) {
                log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
                break;
              }

              continue;
            }

            const parsedMaster: any = HLS.parse(masterPlaylistContent);

            if (!parsedMaster) {
              log.error(`[${vodId}] Failed to parse Twitch master playlist`);
              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 5000));

              continue;
            }

            const bestVariantUrl = parsedMaster.variants?.[0]?.uri || parsedMaster.uri;

            if (!bestVariantUrl.startsWith('http')) {
              baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));
              variantM3u8String = await axios.get(bestVariantUrl.includes('/') ? bestVariantUrl : `${baseURL}/${bestVariantUrl}`).then((r) => r.data);
            } else {
              baseURL = bestVariantUrl.substring(0, bestVariantUrl.lastIndexOf('/'));
              variantM3u8String = await axios.get(bestVariantUrl).then((r) => r.data);
            }
          } catch (error: any) {
            log.error(`[${vodId}] Failed to fetch Twitch HLS playlist:`, error.message);

            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

            if (retryCount > maxRetryBeforeEndDetection) {
              log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
              break;
            }

            continue;
          }
        } else if (platform === 'kick') {
          const fetchUrl = sourceUrl || '';

          if (!fetchUrl) {
            log.error(`[${vodId}] No Kick HLS source URL provided. Cannot continue download.`);

            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 5000));

            if (retryCount > maxRetryBeforeEndDetection * 2) {
              log.error(`[${vodId}] Aborting download - no source URL available after multiple attempts`);

              await prisma.vod.update({ where: { id: vodId }, data: { is_live: false, ended_at: new Date() } as any });

              throw new Error('Kick HLS source URL not available');
            }

            continue;
          }

          baseURL = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));

          if (fetchUrl.includes('master.m3u8')) {
            const baseEndpoint = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
            baseURL = `${baseEndpoint}/1080p60`;

            variantM3u8String = await axios.get(`${baseURL}/playlist.m3u8`).then((r) => r.data);
          } else {
            try {
              const response = await axios.get(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });

              variantM3u8String = response.data;
            } catch (error: any) {
              log.error(`[${vodId}] Failed to fetch Kick HLS playlist from ${fetchUrl}:`, error.message);

              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 5000 * Math.min(retryCount, 6)));

              if (retryCount > maxRetryBeforeEndDetection) {
                log.warn(`[${vodId}] Too many consecutive failures. Assuming stream ended or platform issue.`);
                break;
              }

              continue;
            }
          }
        }

        const parsedM3u8: any = HLS.parse(variantM3u8String);

        if (!parsedM3u8) {
          log.error(`[${vodId}] Invalid HLS playlist structure`);

          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 5000));

          continue;
        }

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
      await updateDiscordMessage(messageId, `[Live Stream] ${vodId} - Download complete. Converting to MP4...`);
    }

    log.info(`[${vodId}] Stream download complete. Starting finalization...`);

    try {
      const filesInDir = await fsPromises.readdir(vodDir);
      const tsFilesCount = filesInDir.filter((f) => f.endsWith('.ts')).length;

      if (tsFilesCount === 0) throw new Error(`No TS segments found in ${vodDir}. Download may have failed or stream was empty.`);

      log.info(`[${vodId}] Found ${tsFilesCount} TS segments. Starting MP4 conversion...`);

      const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(userId), `${vodId}.mp4`);

      await convertHlsToMp4(m3u8Path, vodId, finalMp4Path);

      log.info(`[${vodId}] MP4 conversion complete. File saved to ${finalMp4Path}`);

      const actualDuration = await getVideoDuration(finalMp4Path);

      if (actualDuration) {
        const formattedDuration = toHHMMSS(Math.round(actualDuration));

        await prisma.vod.update({ where: { id: vodId }, data: { duration: formattedDuration, is_live: false, ended_at: new Date() } as any });

        log.info(`[${vodId}] Updated VOD with duration ${formattedDuration} and marked as ended`);

        if (isAlertsEnabled() && messageId) {
          await updateDiscordMessage(messageId, `[Live Stream] ${vodId} - Complete! Duration: ${formattedDuration}`);
        }
      } else {
        log.warn(`[${vodId}] Could not determine video duration from MP4 file`);
        await prisma.vod.update({ where: { id: vodId }, data: { is_live: false, ended_at: new Date() } as any });
      }

      if (config.youtube) {
        const youtubeJob = {
          streamerId: String(userId),
          vodId,
          filePath: finalMp4Path,
          title: `Live Stream - ${vodId}`,
          description: '',
          type: 'vod' as const,
        };
        await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube:${vodId}` });
        log.info(`[${vodId}] YouTube upload job queued`);
      }

      if (!config.settings.saveHLS) {
        try {
          await fsPromises.rm(vodDir, { recursive: true });
        } catch (error: any) {
          // Non-critical cleanup failure
          log.warn(`[${vodId}] Failed to clean up temporary directory ${vodDir}:`, error.message);
        }
      } else {
        log.info(`[${vodId}] HLS files preserved in ${vodDir} (saveHLS=true)`);
      }

      resetFailures(String(userId));

      return { success: true, finalPath: finalMp4Path, durationSeconds: actualDuration };
    } catch (error: any) {
      log.error(`[${vodId}] Finalization failed:`, error.message);

      if (messageId && isAlertsEnabled()) {
        await updateDiscordMessage(messageId, `[Live Stream] ${vodId} FAILED: ${(error as Error).message}`);
      }

      throw new Error('Stream finalization failed: ' + (error as Error).message);
    }
  } else {
    // Alerts disabled - just do the download without Discord notifications
    const vodDir = pathMod.join(config.settings.vodPath || '', String(userId), vodId);

    try {
      await fsPromises.mkdir(vodDir, { recursive: true });
      log.info(`[${vodId}] Created download directory (alerts disabled): ${vodDir}`);
    } catch (error: any) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`Failed to create VOD directory ${vodDir}: ${(error as Error).message}`);
      }
    }

    const m3u8Path = pathMod.join(vodDir, `${vodId}.m3u8`);
    let retryCount = 0;
    let lastSegmentUri: string | null = null;
    let noChangePollCounter = 0;
    let baseURL: string = '';

    log.info(`[${vodId}] Starting HLS polling loop (alerts disabled)...`);

    while (true) {
      try {
        log.debug(`[${vodId}] Polling HLS playlist...`);

        let variantM3u8String = '';

        if (platform === 'twitch') {
          const tokenSig = await getVodTokenSig(vodId);
          const masterPlaylistContent = await getTwitchM3u8(vodId, tokenSig.value, tokenSig.signature);

          if (!masterPlaylistContent) throw new Error('Failed to fetch Twitch master playlist');

          const parsedMaster: any = HLS.parse(masterPlaylistContent);

          if (!parsedMaster) throw new Error('Failed to parse Twitch master playlist');

          const bestVariantUrl = parsedMaster.variants?.[0]?.uri || parsedMaster.uri;

          baseURL = masterPlaylistContent.substring(0, masterPlaylistContent.lastIndexOf('/'));
          variantM3u8String = await axios.get(bestVariantUrl.includes('/') ? bestVariantUrl : `${baseURL}/${bestVariantUrl}`).then((r) => r.data);
        } else if (platform === 'kick') {
          const fetchUrl = sourceUrl || '';

          if (!fetchUrl) throw new Error('No Kick HLS source URL provided');

          baseURL = fetchUrl.substring(0, fetchUrl.lastIndexOf('/'));
          variantM3u8String = await axios.get(fetchUrl).then((r) => r.data);
        }

        const parsedM3u8: any = HLS.parse(variantM3u8String);

        if (!parsedM3u8) throw new Error('Invalid HLS playlist structure');

        await fsPromises.writeFile(m3u8Path, variantM3u8String);

        const currentLastSegment = parsedM3u8.segments?.[parsedM3u8.segments.length - 1]?.uri || '';

        if (lastSegmentUri === currentLastSegment && lastSegmentUri !== null) {
          noChangePollCounter++;

          if (noChangePollCounter >= 60) break; // Stream end detection
        } else {
          lastSegmentUri = currentLastSegment;
          noChangePollCounter = 0;
        }

        const newSegments = (parsedM3u8.segments || []).filter((seg: any) => !fileExists(`${vodDir}/${seg.uri}`));

        if (newSegments.length > 0) {
          await downloadTSSegmentsSequentially(newSegments, vodDir, baseURL);
        }

        retryCount = 0;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error: any) {
        log.error(`[${vodId}] Error in poll cycle:`, error.message);

        retryCount++;
        if (retryCount > 24) throw new Error('HLS polling failed repeatedly'); // Using hardcoded value instead of constant reference

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    log.info(`[${vodId}] Stream download complete. Starting finalization...`);

    const filesInDir = await fsPromises.readdir(vodDir);
    const tsFilesCount = filesInDir.filter((f) => f.endsWith('.ts')).length;

    if (tsFilesCount === 0) throw new Error('No TS segments found');

    log.info(`[${vodId}] Found ${tsFilesCount} TS segments. Starting MP4 conversion...`);

    const finalMp4Path = pathMod.join(config.settings.vodPath || '', String(userId), `${vodId}.mp4`);
    await convertHlsToMp4(m3u8Path, vodId, finalMp4Path);

    log.info(`[${vodId}] MP4 conversion complete.`);

    const actualDuration = await getVideoDuration(finalMp4Path);

    if (actualDuration) {
      const formattedDuration = toHHMMSS(Math.round(actualDuration));
      await prisma.vod.update({ where: { id: vodId }, data: { duration: formattedDuration, is_live: false, ended_at: new Date() } as any });
    }

    if (config.youtube) {
      const youtubeJob = { streamerId: String(userId), vodId, filePath: finalMp4Path, title: `Live Stream - ${vodId}`, description: '', type: 'vod' as const };
      await (getYoutubeUploadQueue() as any).add(youtubeJob, { id: `youtube:${vodId}` });
    }

    if (!config.settings.saveHLS) {
      try {
        await fsPromises.rm(vodDir, { recursive: true });
      } catch {}
    }

    resetFailures(String(userId));
    return { success: true, finalPath: finalMp4Path };
  }
}

const vodProcessor: Processor<any> = async (job: Job<any>) => {
  if (job.name === 'live_hls_download') {
    const liveJob = job as Job<LiveHlsDownloadJobData>;
    try {
      return await processLiveHlsDownload(liveJob);
    } finally {
      await clearVodDedupKey(liveJob.data.vodId);
    }
  } else {
    throw new Error('Standard VOD download mode not yet implemented in this worker version');
  }
};

export default vodProcessor;
