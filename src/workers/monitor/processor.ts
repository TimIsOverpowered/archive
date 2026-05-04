import { Processor, Job } from 'bullmq';
import { requirePlatformConfig } from '../../config/types.js';
import { findActiveLiveVod } from '../../db/queries/vods.js';
import { PLATFORM_VALUES } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { getLiveDownloadQueue, LIVE_JOB_ID_PREFIX } from '../queues/queue.js';
import { handleWorkerError } from '../utils/error-handler.js';
import { getJobContext } from '../utils/job-context.js';
import { handlePlatformLiveCheck } from './live-handler.js';

const monitorProcessor: Processor<{ tenantId: string }, unknown, string> = async (job: Job<{ tenantId: string }>) => {
  const { tenantId } = job.data;
  const log = createAutoLogger(tenantId);
  const { config, db } = await getJobContext(tenantId);

  const liveQueue = getLiveDownloadQueue();

  for (const platform of PLATFORM_VALUES) {
    if (!requirePlatformConfig(config, platform)) {
      continue;
    }

    const activeLiveVod = await findActiveLiveVod(db, platform);

    if (activeLiveVod && activeLiveVod.platform_vod_id != null && activeLiveVod.platform_vod_id !== '') {
      const jobId = `${LIVE_JOB_ID_PREFIX}${activeLiveVod.platform_vod_id}`;
      const queuedJob = await liveQueue.getJob(jobId);
      const hasActiveJob = queuedJob !== undefined && (await queuedJob.isActive());
      if (hasActiveJob) {
        log.debug(
          { component: 'monitor', platform, vodId: activeLiveVod.platform_vod_id },
          'Skipping - live worker active'
        );
        continue;
      }
      log.debug(
        { component: 'monitor', platform, vodId: activeLiveVod.platform_vod_id },
        'No active job found, rechecking'
      );
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
