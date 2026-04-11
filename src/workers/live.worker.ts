// live.worker.ts
import { Processor, Job } from 'bullmq';
import { downloadLiveHls } from './vod/hls-downloader.js';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { convertHlsToMp4, getDuration } from '../utils/ffmpeg.js';
import { finalizeKickChapters } from '../services/kick.js';
import { saveVodChapters as saveTwitchVodChapters } from '../services/twitch.js';
import { fileExists, getVodDirPath, getVodFilePath } from '../utils/path.js';
import { getTenantConfig } from '../config/loader.js';
import { toHHMMSS } from '../utils/formatting.js';
import { sendRichAlert, updateDiscordEmbed, isAlertsEnabled } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { getClient } from '../db/client.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { retryWithBackoff } from '../utils/retry.js';
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
}

const liveProcessor: Processor<LiveDownloadJobData, unknown, string> = async (job: Job<LiveDownloadJobData, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Live Worker] Starting job');

  const streamerClient = getClient(tenantId);
  if (!streamerClient) throw new Error(`DB client not available for ${tenantId}`);

  const config = getTenantConfig(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const messageId = await initAlert(vodId, platform, config.displayName || tenantId, startedAt);

  try {
    // 1. Prepare directory
    const vodDirPath = getVodDirPath({ tenantId, vodId });
    if (await fileExists(vodDirPath)) {
      await cleanupOrphanedTmpFiles(vodDirPath, log);
    }

    // 2. Download
    const downloadResult = await downloadLiveHls({
      dbId,
      vodId,
      platform,
      tenantId,
      platformUserId,
      platformUsername,
      startedAt,
      sourceUrl,
      onProgress: (segmentsDownloaded) => {
        updateAlert(messageId, `[Live] Downloading ${vodId}`, `${segmentsDownloaded} segments downloaded`, 'warning', []);
      },
    });

    await updateAlert(messageId, `[Live] Converting ${vodId}`, 'Download complete. Converting...', 'warning', [{ name: 'Segments', value: String(downloadResult.segmentCount), inline: true }]);

    // 3. Convert
    const finalMp4Path = getVodFilePath({ tenantId, vodId });
    await convertToMp4(vodId, downloadResult, finalMp4Path, log);

    // 4. Update DB
    const actualDuration = await getDuration(finalMp4Path);
    await finalizeVod({ dbId, vodId, platform, tenantId, durationSeconds: actualDuration ? Math.round(actualDuration) : null, streamerClient });

    await updateAlert(messageId, `[Live] ${vodId} Complete`, 'Successfully processed', 'success', [
      { name: 'Duration', value: actualDuration ? toHHMMSS(Math.round(actualDuration)) : 'Unknown', inline: true },
    ]);

    // 5. Queue upload (non-fatal)
    try {
      //await queueYoutubeUpload(tenantId, dbId, vodId, finalMp4Path, uploadMode || 'all', platform, log);
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to queue upload (non-fatal)');
    }

    // 6. Cleanup HLS segments
    if (!config.settings.saveHLS) {
      await fs.rm(downloadResult.outputDir, { recursive: true }).catch((error) => {
        log.warn({ ...extractErrorDetails(error), vodId }, 'HLS cleanup failed (non-fatal)');
      });
    }

    log.info({ jobId: job.id, vodId }, '[Live Worker] Job completed successfully');
    return { success: true };
  } catch (error) {
    const details = extractErrorDetails(error);
    log.error({ jobId: job.id, ...details, vodId }, '[Live Worker] Job failed');
    await updateAlert(messageId, `[Live] ${vodId} FAILED`, details.message.substring(0, 500), 'error', []);
    throw error;
  }
};

// --- Helpers ---

async function convertToMp4(vodId: string, downloadResult: { m3u8Path: string; outputDir: string }, finalMp4Path: string, log: ReturnType<typeof createAutoLogger>) {
  const files = await fs.readdir(downloadResult.outputDir).catch(() => [] as string[]);
  const mp4Segments = files.filter((f) => f.endsWith('.mp4'));
  const tsSegments = files.filter((f) => f.endsWith('.ts'));
  const hasInitSegment = files.some((f) => f.includes('init') && f.endsWith('.mp4'));

  if (mp4Segments.length === 0 && tsSegments.length === 0) {
    throw new Error(`No valid segments found in ${downloadResult.outputDir}`);
  }

  const isFmp4 = hasInitSegment && mp4Segments.length > 0;
  log.info(`[${vodId}] Converting ${isFmp4 ? 'fMP4' : 'TS'} segments to MP4`);

  // Let BullMQ handle job-level retries — only retry here for transient ffmpeg failures
  await retryWithBackoff(() => convertHlsToMp4(downloadResult.m3u8Path, finalMp4Path, { vodId, isFmp4 }), {
    attempts: 3,
    baseDelayMs: 5000,
  });

  log.info(`[${vodId}] Conversion complete`);
}

async function finalizeVod({
  dbId,
  vodId,
  platform,
  tenantId,
  durationSeconds,
  streamerClient,
}: {
  dbId: number;
  vodId: string;
  platform: string;
  tenantId: string;
  durationSeconds: number | null;
  streamerClient: NonNullable<ReturnType<typeof getClient>>;
}) {
  if (durationSeconds) {
    if (platform === 'kick') {
      await finalizeKickChapters(dbId, vodId, durationSeconds, streamerClient);
    } else if (platform === 'twitch') {
      await saveTwitchVodChapters(dbId, vodId, tenantId, durationSeconds, streamerClient);
    }
    await streamerClient.vod.update({ where: { id: dbId }, data: { duration: durationSeconds, is_live: false } });
  } else {
    await streamerClient.vod.update({ where: { id: dbId }, data: { is_live: false } });
  }
}

async function initAlert(vodId: string, platform: string, streamerName: string, startedAt?: string) {
  if (!isAlertsEnabled()) return null;
  try {
    return await sendRichAlert({
      title: `[Live] ${vodId} Started`,
      description: `${platform.toUpperCase()} live stream download started`,
      status: 'warning',
      fields: [
        { name: 'Platform', value: platform, inline: true },
        { name: 'Streamer', value: streamerName, inline: true },
        { name: 'Started At', value: startedAt || new Date().toISOString(), inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

async function updateAlert(messageId: string | null, title: string, description: string, status: 'warning' | 'success' | 'error', fields: { name: string; value: string; inline: boolean }[]) {
  if (!messageId || !isAlertsEnabled()) return;
  await updateDiscordEmbed(messageId, { title, description, status, fields, timestamp: new Date().toISOString() }).catch(() => {});
}

export default liveProcessor;
