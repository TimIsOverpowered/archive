import { Processor, Job } from 'bullmq';
import { getVodFilePath } from '../utils/path.js';
import { initRichAlert, updateAlert } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { getJobContext } from './utils/job-context.js';
import { handleWorkerError } from './utils/error-handler.js';
import { createVodWorkerAlerts } from './utils/alert-factories.js';
import type { StandardVodJob } from './jobs/queues.js';
import { downloadVodWithFfmpeg, downloadVodWithHls } from './vod/vod-download-strategies.js';
import { DOWNLOAD_METHODS } from '../types/platforms.js';

const vodProcessor: Processor<StandardVodJob, unknown, string> = async (job: Job<StandardVodJob, unknown, string>) => {
  const { dbId, vodId, platform, tenantId, downloadMethod = DOWNLOAD_METHODS.HLS } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, dbId, vodId, platform, tenantId }, '[Standard VOD Worker] Starting job');

  const { config } = await getJobContext(tenantId);
  if (!config?.settings.vodPath) throw new Error(`VOD path not configured for ${tenantId}`);

  const finalPath = getVodFilePath({ config, vodId });
  const streamerName = config.displayName || tenantId;
  const alerts = createVodWorkerAlerts();

  const messageId = await initRichAlert(alerts.init(vodId, platform, streamerName));

  try {
    if (downloadMethod === 'ffmpeg') {
      await downloadVodWithFfmpeg(platform, vodId, finalPath, config, log);
    } else {
      await downloadVodWithHls(platform, vodId, finalPath, tenantId, config, log);
    }

    log.info({ vodId, platform }, `Downloaded ${vodId}.mp4`);

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
