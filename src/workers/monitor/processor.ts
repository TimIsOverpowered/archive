import { Processor, Job } from 'bullmq';
import { getJobContext } from '../utils/job-context.js';
import { handlePlatformLiveCheck } from './live-handler.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { handleWorkerError } from '../utils/error-handler.js';
import { PLATFORM_VALUES } from '../../types/platforms.js';
import { getLiveDownloadQueue } from '../jobs/queues.js';
import { findActiveLiveVod } from '../../services/vods.service.js';

const monitorProcessor: Processor<{ tenantId: string }, unknown, string> = async (job: Job<{ tenantId: string }>) => {
  const { tenantId } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, tenantId }, '[Monitor] Starting poll cycle');

  const { config, db } = await getJobContext(tenantId);

  if (!config?.settings.vodDownload) {
    log.debug({ tenantId }, '[Monitor] VOD download disabled, skipping');
    return { success: true };
  }

  const liveQueue = getLiveDownloadQueue();
  const activeLiveJobs = await liveQueue.getActive();

  for (const platform of PLATFORM_VALUES) {
    const platformConfig = config[platform];
    if (!platformConfig?.enabled || !platformConfig.username) {
      continue;
    }

    const activeLiveVod = await findActiveLiveVod(db, platform);

    if (activeLiveVod) {
      const hasActiveJob = activeLiveJobs.some((j) => j.opts.jobId === `live_hls_${activeLiveVod.vod_id}`);
      if (hasActiveJob) {
        log.debug({ platform, vodId: activeLiveVod.vod_id }, '[Monitor] Skipping - live worker active');
        continue;
      }
      log.debug({ platform, vodId: activeLiveVod.vod_id }, '[Monitor] No active job found, rechecking');
    }

    try {
      await handlePlatformLiveCheck(db, tenantId, platform, config, activeLiveVod ?? null);
    } catch (error) {
      handleWorkerError(error, log, { platform, tenantId });
    }
  }

  log.debug({ jobId: job.id, tenantId }, '[Monitor] Poll cycle completed');
  return { success: true };
};

export default monitorProcessor;
