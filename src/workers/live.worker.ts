import { Processor, Job } from 'bullmq';
import { downloadLiveHls } from './vod/hls-downloader.js';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { convertHlsToMp4, getDuration } from '../utils/ffmpeg.js';
import { finalizeKickChapters } from '../services/kick.js';
import { saveVodChapters as saveTwitchVodChapters } from '../services/twitch.js';
import { fileExists } from '../utils/path.js';
import { getTenantConfig } from '../config/loader.js';
import { getJobContext } from './job-context.js';
import { getYoutubeUploadQueue } from './jobs/queues.js';
import { toHHMMSS } from '../utils/formatting.js';
import { sendRichAlert, updateDiscordEmbed, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { getClient } from '../db/client.js';
import fs from 'fs/promises';

export interface LiveDownloadJobData {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  platformUserId: string;
  platformUsername?: string;
  startedAt?: string;
  sourceUrl?: string;
  uploadMode?: 'vod' | 'all';
}

const liveProcessor: Processor<LiveDownloadJobData, unknown, string> = async (job: Job<LiveDownloadJobData, unknown, string>) => {
  const signal = (job.token as { abortSignal?: AbortSignal })?.abortSignal;

  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl, uploadMode } = job.data;

  const { createAutoLogger: loggerWithTenant } = await import('../utils/auto-tenant-logger.js');

  const log = loggerWithTenant(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Live Worker] Starting job processing');

  const streamerClient = getClient(tenantId);

  if (!streamerClient) {
    throw new Error(`Streamer database client not available for ${tenantId}`);
  }

  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`VOD path not configured for tenant ${tenantId}`);
  }

  const streamerName = config.displayName || tenantId;

  let messageId: string | null = null;

  if (isAlertsEnabled()) {
    try {
      const startTime = new Date().toISOString();

      messageId = await sendRichAlert({
        title: `[Live] ${vodId} Started`,
        description: `${platform.toUpperCase()} live stream download started`,
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Streamer', value: streamerName, inline: true },
          { name: 'Started At', value: startedAt || startTime, inline: false },
        ],
        timestamp: startTime,
      });
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn(`Failed to initialize Discord alert: ${details.message}`);
    }
  }

  try {
    const { getVodDirPath } = await import('../utils/path.js');

    const vodDirPath = getVodDirPath({ tenantId, vodId });

    const exists = await fileExists(vodDirPath);

    if (exists) {
      log.debug({ vodId, platform }, `[Recovery] Directory found - cleaning orphaned temp files`);
      await cleanupOrphanedTmpFiles(vodDirPath, log);
    } else {
      log.debug({ vodId, platform }, `[Recovery] Fresh start - directory will be created`);
    }

    const downloadResult = await downloadLiveHls(
      {
        dbId,
        vodId,
        platform,
        tenantId,
        platformUserId,
        platformUsername,
        startedAt,
        sourceUrl,
      },
      signal
    );

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `[Live] Converting ${vodId}`,
        description: 'Download complete. MP4 conversion in progress...',
        status: 'warning',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Total Segments', value: String(downloadResult.segmentCount), inline: false },
        ],
        timestamp: startedAt || new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    const { getVodFilePath } = await import('../utils/path.js');

    const finalMp4Path = getVodFilePath({ tenantId, vodId });

    let hasInitSegment = false;
    let mp4Segments: string[] = [];
    let tsSegments: string[] = [];

    try {
      const filesInDir = await fs.readdir(downloadResult.outputDir);
      mp4Segments = filesInDir.filter((f) => f.endsWith('.mp4'));
      tsSegments = filesInDir.filter((f) => f.endsWith('.ts'));
      hasInitSegment = filesInDir.some((f) => f.includes('init') && f.endsWith('.mp4'));
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, `Failed to read segment files`);
    }

    let conversionAttempts = 0;
    const maxConversionAttempts = 3;

    while (conversionAttempts < maxConversionAttempts) {
      try {
        if (hasInitSegment && mp4Segments.length > 0) {
          log.info(`[${vodId}] Detected fMP4 segments (${mp4Segments.length} files).`);
          await convertHlsToMp4(downloadResult.m3u8Path, finalMp4Path, { vodId, isFmp4: true });
          log.info(`[${vodId}] fMP4 merging complete.`);
        } else if (tsSegments.length > 0) {
          log.info(`[${vodId}] Found ${tsSegments.length} TS segments. Starting MP4 conversion...`);
          await convertHlsToMp4(downloadResult.m3u8Path, finalMp4Path, { vodId, isFmp4: false });
          log.info(`[${vodId}] MP4 conversion complete.`);
        } else {
          throw new Error(`No valid segments found in ${downloadResult.outputDir}.`);
        }

        break;
      } catch (error) {
        conversionAttempts++;
        const details = extractErrorDetails(error);

        if (conversionAttempts >= maxConversionAttempts) {
          log.error({ ...details, vodId, attempts: conversionAttempts }, `Conversion failed after ${maxConversionAttempts} attempts`);
          throw error;
        }

        const delay = 5000 * Math.pow(2, conversionAttempts - 1);
        log.warn({ vodId, attempt: conversionAttempts, nextRetryIn: delay }, `Conversion failed, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

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
    } else {
      log.warn(`[${vodId}] Could not determine video duration from MP4 file`);
      await streamerClient.vod.update({ where: { id: dbId }, data: { is_live: false } });
    }

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `[Live] ${vodId} Complete!`,
        description: `${platform.toUpperCase()} live stream successfully processed`,
        status: 'success',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Duration', value: actualDuration ? toHHMMSS(Math.round(actualDuration)) : 'Unknown', inline: false },
        ],
        timestamp: startedAt || new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    try {
      const { queueYoutubeUpload } = await import('../utils/upload-queue.js');
      await queueYoutubeUpload(tenantId, dbId, vodId, finalMp4Path, uploadMode || 'all', platform, log);
      log.info({ vodId }, `Upload job(s) queued after live download completion`);
    } catch (error) {
      const details = extractErrorDetails(error);
      log.warn({ ...details, vodId }, `Failed to queue upload job (non-fatal)`);
    }

    if (!config.settings.saveHLS) {
      try {
        await fs.rm(downloadResult.outputDir, { recursive: true });
      } catch (error) {
        const details = extractErrorDetails(error);
        log.warn({ ...details, vodId }, `Cleanup failed`);
      }
    }

    log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Live Worker] Job completed successfully');

    return { success: true };
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error({ jobId: job.id, ...details, vodId }, `[Live Worker] Job failed`);

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `[Live] ${vodId} FAILED`,
        description: `${platform.toUpperCase()} live stream processing failed`,
        status: 'error',
        fields: [
          { name: 'Platform', value: platform, inline: true },
          { name: 'Error', value: errorMsg, inline: false },
        ],
        timestamp: startedAt || new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
};

export default liveProcessor;
