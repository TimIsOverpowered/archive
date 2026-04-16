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
import { queueYoutubeUploads, type YoutubeUploadJobResult } from './jobs/youtube.job.js';
import { type LiveCompletionData } from './utils/alert-factories.js';

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

    await updateAlert(messageId, alerts.converting(vodId, downloadResult.segmentCount));

    // 3. Update DB
    const finalMp4Path = downloadResult.finalMp4Path;
    const actualDuration = await getDuration(finalMp4Path);
    await finalizeVod({ ctx, dbId, vodId, platform, durationSeconds: actualDuration ? Math.round(actualDuration) : null });

    // Track completion data
    let emotesSaved = false;
    let chatJobId: string | null = null;
    let youtubeResult: YoutubeUploadJobResult = { vodJobId: null, gameJobIds: [] };

    // 4. Save Emotes
    try {
      await fetchAndSaveEmotes(ctx, dbId, platform, platformUserId);
      emotesSaved = true;
      await updateAlert(messageId, alerts.emotesSaved(vodId));
      log.info({ vodId }, 'Queued emote save');
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to save emotes (non-fatal)');
    }

    // 5. Queue chat download (non-fatal)
    try {
      chatJobId = await triggerChatDownload(tenantId, platformUserId, dbId, vodId, platform, actualDuration ? Math.round(actualDuration) : 0, platformUsername);
      if (chatJobId) {
        await updateAlert(messageId, alerts.chatQueued(vodId));
      }
      log.info({ vodId, chatJobId }, 'Queued chat download job');
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to queue chat download (non-fatal)');
    }

    // 6. Queue upload (non-fatal)
    try {
      youtubeResult = await queueYoutubeUploads({ ctx, dbId, vodId, filePath: finalMp4Path, platform, log });
      if (youtubeResult.vodJobId || youtubeResult.gameJobIds.length > 0) {
        await updateAlert(messageId, alerts.uploadQueued(vodId));
      }
    } catch (error) {
      log.warn({ ...extractErrorDetails(error), vodId }, 'Failed to queue upload (non-fatal)');
    }

    // 7. Final completion alert with all data
    const completionData: LiveCompletionData = {
      emotesSaved,
      chatJobId,
      youtubeVodJobId: youtubeResult.vodJobId,
      youtubeGameJobIds: youtubeResult.gameJobIds,
      segmentCount: downloadResult.segmentCount,
      finalPath: finalMp4Path,
    };

    await updateAlert(messageId, alerts.complete(vodId, actualDuration ? Math.round(actualDuration) : undefined, completionData));

    log.info({ jobId: job.id, vodId }, '[Live Worker] Job completed successfully');
    return { success: true };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, jobId: job.id, platform, dbId, tenantId });
    await updateAlert(messageId, alerts.error(vodId, errorMsg));
    throw error;
  }
};

export default liveProcessor;
