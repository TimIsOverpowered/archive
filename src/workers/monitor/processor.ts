import { Processor, Job } from 'bullmq';
import { getJobContext } from '../utils/job-context.js';
import { handlePlatformLiveCheck } from './live-handler.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { handleWorkerError } from '../utils/error-handler.js';
import type { Platform } from '../../types/platforms.js';

const monitorProcessor: Processor<{ tenantId: string }, unknown, string> = async (job: Job<{ tenantId: string }>) => {
  const { tenantId } = job.data;
  const log = createAutoLogger(tenantId);

  log.info({ jobId: job.id, tenantId }, '[Monitor] Starting poll cycle');

  const { config, db } = await getJobContext(tenantId);

  if (!config?.settings.vodDownload) {
    log.debug({ tenantId }, '[Monitor] VOD download disabled, skipping');
    return { success: true };
  }

  const platforms: Platform[] = ['twitch', 'kick'];

  for (const platform of platforms) {
    const platformConfig = config[platform];
    if (!platformConfig?.enabled || !platformConfig.username) {
      continue;
    }

    const activeLiveVod = await db
      .selectFrom('vods')
      .selectAll()
      .where('platform', '=', platform)
      .where('is_live', '=', true)
      .executeTakeFirst();

    if (activeLiveVod) {
      log.debug({ platform, vodId: activeLiveVod.vod_id }, '[Monitor] Skipping - live worker active');
      continue;
    }

    try {
      await handlePlatformLiveCheck(db, tenantId, platform, config);
    } catch (error) {
      handleWorkerError(error, log, { platform, tenantId });
    }
  }

  log.debug({ jobId: job.id, tenantId }, '[Monitor] Poll cycle completed');
  return { success: true };
};

export default monitorProcessor;
