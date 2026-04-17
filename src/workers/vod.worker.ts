import { Processor, Job } from 'bullmq';
import { getVodFilePath, getVodDirPath, fileExists } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { createVodWorkerAlerts } from './utils/alert-factories.js';
import type { StandardVodJob } from './jobs/queues.js';
import { downloadVodWithFfmpeg } from './vod/vod-download-strategies.js';
import { DOWNLOAD_METHODS, PLATFORMS } from '../types/platforms.js';
import { downloadHlsStream } from './vod/hls-orchestrator.js';
import { cleanupOrphanedTmpFiles } from './vod/hls-utils.js';

const vodProcessor: Processor<StandardVodJob, unknown, string> = async (job: Job<StandardVodJob, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, downloadMethod = DOWNLOAD_METHODS.HLS, platformUserId, platformUsername, sourceUrl } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Starting job');

  const ctx = await getJobContext(tenantId);
  const { config } = ctx;
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const finalPath = getVodFilePath({ config, vodId });
  const streamerName = config.displayName || tenantId;
  const alerts = createVodWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName));

  try {
    if (downloadMethod === 'ffmpeg') {
      await downloadVodWithFfmpeg(platform, vodId, finalPath, config, log);
    } else {
      const vodDirPath = getVodDirPath({ config, vodId });
      if (await fileExists(vodDirPath)) {
        await cleanupOrphanedTmpFiles(vodDirPath, log);
      }

      if (!platformUserId) {
        throw new Error(`Platform user ID not configured for ${platform}`);
      }

      if (platform === PLATFORMS.KICK && !sourceUrl) {
        throw new Error('Kick source URL not available for VOD');
      }

      await downloadHlsStream({
        ctx,
        dbId,
        vodId,
        platform,
        platformUserId,
        platformUsername,
        sourceUrl,
        isLive: false,
        discordMessageId: messageId || undefined,
        streamerName,
      });

      log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);
    }

    await updateAlert(messageId, alerts.complete(vodId, platform, finalPath));

    log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Job completed successfully');
    return { success: true, finalPath };
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, { vodId, platform, jobId: job.id, dbId, tenantId });

    await updateAlert(messageId, alerts.error(vodId, platform, errorMsg));

    throw error;
  }
};

export default vodProcessor;
