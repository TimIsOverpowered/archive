import { Processor, Job } from 'bullmq';
import { getJobContext } from '../utils/job-context.js';
import { handlePlatformLiveCheck } from './live-handler.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { handleWorkerError } from '../utils/error-handler.js';
import { PLATFORM_VALUES } from '../../types/platforms.js';
import { getLiveDownloadQueue, LIVE_JOB_ID_PREFIX } from '../queues/queue.js';
import { findActiveLiveVod } from '../../services/vods.service.js';
import { getPlatformConfig } from '../../config/types.js';

const monitorProcessor: Processor<{ tenantId: string }, unknown, string> = async (job: Job<{ tenantId: string }>) => {
  const { tenantId } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ component: 'monitor', jobId: job.id, tenantId }, 'Starting poll cycle');

  const { config, db } = await getJobContext(tenantId);

  if (!config?.settings.vodDownload) {
    log.debug({ component: 'monitor', tenantId }, 'VOD download disabled, skipping');
    return { success: true };
  }

  const liveQueue = getLiveDownloadQueue();

  for (const platform of PLATFORM_VALUES) {
    const platformConfig = getPlatformConfig(config, platform);
    if (!platformConfig?.enabled || !platformConfig.username) {
      continue;
    }

    const activeLiveVod = await findActiveLiveVod(db, platform);

    if (activeLiveVod) {
      const jobId = `${LIVE_JOB_ID_PREFIX}${activeLiveVod.vod_id}`;
      const queuedJob = await liveQueue.getJob(jobId);
      const hasActiveJob = queuedJob !== undefined && (await queuedJob.isActive());
      if (hasActiveJob) {
        log.debug({ component: 'monitor', platform, vodId: activeLiveVod.vod_id }, 'Skipping - live worker active');
        continue;
      }
      log.debug({ component: 'monitor', platform, vodId: activeLiveVod.vod_id }, 'No active job found, rechecking');
    }

    try {
      await handlePlatformLiveCheck(db, tenantId, platform, config, activeLiveVod ?? null);
    } catch (error) {
      handleWorkerError(error, log, { platform, tenantId });
    }
  }

  log.debug({ component: 'monitor', jobId: job.id, tenantId }, 'Poll cycle completed');
  return { success: true };
};

export default monitorProcessor;
