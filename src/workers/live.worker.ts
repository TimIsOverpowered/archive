// live.worker.ts
import { Processor, Job } from 'bullmq';
import { downloadLiveHls } from './vod/hls-downloader.js';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { convertHlsToMp4, getDuration } from '../utils/ffmpeg.js';
import { fileExists, getVodDirPath, getVodFilePath } from '../utils/path.js';
import { toHHMMSS } from '../utils/formatting.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getJobContext } from './job-context.js';
import { finalizeVod } from '../services/vod-finalization.js';
import { queueYoutubeUploads } from './jobs/youtube.job.js';
import fs from 'fs/promises';

type LiveDownloadJobData = import('./jobs/queues.js').LiveDownloadJob;

export { type LiveDownloadJobData };

const liveProcessor: Processor<LiveDownloadJobData, unknown, string> = async (job: Job<LiveDownloadJobData, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Live Worker] Starting job');

  const { config, db: streamerClient } = await getJobContext(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const messageId = await initRichAlert({
    title: `[Live] ${vodId} Started`,
    description: `${platform.toUpperCase()} live stream download started`,
    status: 'warning',
    fields: [
      { name: 'Platform', value: platform, inline: true },
      { name: 'Streamer', value: config.displayName || tenantId, inline: true },
      { name: 'Started At', value: startedAt || new Date().toISOString(), inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

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
        void updateAlert(messageId, {
          title: `[Live] Downloading ${vodId}`,
          description: `${segmentsDownloaded} segments downloaded`,
          status: 'warning',
          fields: [],
          timestamp: new Date().toISOString(),
        });
      },
    });

    await updateAlert(messageId, {
      title: `[Live] Converting ${vodId}`,
      description: 'Download complete. Converting...',
      status: 'warning',
      fields: [{ name: 'Segments', value: String(downloadResult.segmentCount), inline: true }],
      timestamp: new Date().toISOString(),
    });

    // 3. Convert
    const finalMp4Path = getVodFilePath({ tenantId, vodId });
    await convertToMp4(vodId, downloadResult, finalMp4Path, log);

    // 4. Update DB
    const actualDuration = await getDuration(finalMp4Path);
    await finalizeVod({ dbId, vodId, platform, tenantId, durationSeconds: actualDuration ? Math.round(actualDuration) : null, streamerClient });

    await updateAlert(messageId, {
      title: `[Live] ${vodId} Complete`,
      description: 'Successfully processed',
      status: 'success',
      fields: [{ name: 'Duration', value: actualDuration ? toHHMMSS(Math.round(actualDuration)) : 'Unknown', inline: true }],
      timestamp: new Date().toISOString(),
    });

    // 5. Queue upload (non-fatal)
    try {
      await queueYoutubeUploads({ tenantId, dbId, vodId, filePath: finalMp4Path, platform, config, log });
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
    await updateAlert(messageId, {
      title: `[Live] ${vodId} FAILED`,
      description: details.message.substring(0, 500),
      status: 'error',
      fields: [],
      timestamp: new Date().toISOString(),
    });
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

export default liveProcessor;
