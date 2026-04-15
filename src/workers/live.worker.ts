// live.worker.ts
import { Processor, Job } from 'bullmq';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';
import { getDuration } from './vod/ffmpeg.js';
import { fileExists, getVodDirPath } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { extractErrorDetails } from '../utils/error.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { finalizeVod } from '../services/vod-finalization.js';
import { queueYoutubeUploads } from './jobs/youtube.job.js';
import { cleanupHlsFiles } from './vod/hls-cleanup.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { handleWorkerError } from './utils/error-handler.js';
import { createLiveWorkerAlerts } from './utils/alert-factories.js';
import type { LiveDownloadJob } from './jobs/queues.js';
import { triggerChatDownload } from './jobs/chat.job.js';
import { fetchAndSaveEmotes } from '../services/emotes.js';

const liveProcessor: Processor<LiveDownloadJob, unknown, string> = async (job: Job<LiveDownloadJob, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, platformUserId, platformUsername, startedAt, sourceUrl } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Live Worker] Starting job');

  const ctx = await getJobContext(tenantId);
  const { config } = ctx;
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const streamerName = config.displayName || tenantId;
  const alerts = createLiveWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName, startedAt));

  try {
    // 1. Prepare directory
    const vodDirPath = getVodDirPath({ config, vodId });
    if (await fileExists(vodDirPath)) {
      await cleanupOrphanedTmpFiles(vodDirPath, log);
    }

    // 2. Download (includes conversion)
    const downloadResult = await downloadHlsStream({
      ctx,
      dbId,
      vodId,
      platform,
      platformUserId,
      platformUsername,
      startedAt,
      sourceUrl,
      isLive: true,
      onProgress: (segmentsDownloaded) => {
        void updateAlert(messageId, alerts.progress(vodId, segmentsDownloaded));
      },
    });

    await updateAlert(messageId, {
      title: `[Live] Converting ${vodId}`,
      description: 'Download complete. Converting...',
      status: 'warning',
      fields: [{ name: 'Segments', value: String(downloadResult.segmentCount), inline: true }],
      timestamp: new Date().toISOString(),
    });

    // 3. Update DB
    const finalMp4Path = downloadResult.finalMp4Path;
    const actualDuration = await getDuration(finalMp4Path);
    await finalizeVod({ ctx, dbId, vodId, platform, durationSeconds: actualDuration ? Math.round(actualDuration) : null });

    await updateAlert(messageId, alerts.complete(vodId, actualDuration ? Math.round(actualDuration) : undefined));

    // 4. Save Emotes
    try {
      await fetchAndSaveEmotes(ctx, dbId, platform, platformUserId);
      log.info({ vodId }, 'Queued emote save');
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to save emotes (non-fatal)');
    }

    // 4. Queue upload (non-fatal)
    try {
      await queueYoutubeUploads({ ctx, dbId, vodId, filePath: finalMp4Path, platform, log });
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to queue upload (non-fatal)');
    }

    try {
      await triggerChatDownload(tenantId, platformUserId, dbId, vodId, platform, actualDuration ? Math.round(actualDuration) : 0, platformUsername);
      log.info({ vodId }, 'Queued chat download job');
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to queue chat download (non-fatal)');
    }

    // 6. Cleanup HLS segments
    const shouldKeepHls = config.settings.saveHLS ?? false;
    await cleanupHlsFiles(downloadResult.outputDir, shouldKeepHls, log);

    log.info({ jobId: job.id, vodId }, '[Live Worker] Job completed successfully');
    return { success: true };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, jobId: job.id, platform, dbId, tenantId });
    await updateAlert(messageId, alerts.error(vodId, errorMsg));
    throw error;
  }
};

export default liveProcessor;
