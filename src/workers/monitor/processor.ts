import { Processor, Job } from 'bullmq';
import { configService } from '../../config/tenant-config.js';
import { requirePlatformConfig } from '../../config/types.js';
import type { TenantConfig } from '../../config/types.js';
import { findActiveLiveVod } from '../../db/queries/vods.js';
import { getTwitchStreamStatusBatch, type TwitchStreamStatus } from '../../services/twitch/live.js';
import { PLATFORMS, PLATFORM_VALUES } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { getLogger } from '../../utils/logger.js';
import type { MonitorJob } from '../jobs/types.js';
import { getLiveDownloadQueue, LIVE_JOB_ID_PREFIX } from '../queues/queue.js';
import { handleWorkerError } from '../utils/error-handler.js';
import { getJobContext } from '../utils/job-context.js';
import { handlePlatformLiveCheck, handlePlatformLiveCheckWithStreamStatus } from './live-handler.js';

const monitorProcessor: Processor<MonitorJob, unknown, string> = async (job: Job<MonitorJob>) => {
  const { tenantId, platform } = job.data;

  if (platform === PLATFORMS.TWITCH) {
    return await processTwitchBatchJob(job);
  }

  if (tenantId == null || tenantId === '') {
    throw new Error('Missing tenantId for per-tenant monitor job');
  }

  return await processPerTenantJob(job, tenantId);
};

/**
 * Shared job that batch-polls all Twitch-enabled tenants in one API call,
 * then processes each tenant individually.
 */
async function processTwitchBatchJob(job: Job<MonitorJob>): Promise<{ success: true }> {
  const log = getLogger();
  const liveQueue = getLiveDownloadQueue();

  const twitchTenants = configService
    .getAll()
    .filter((cfg) => cfg.settings.vodDownload === true && requirePlatformConfig(cfg, PLATFORMS.TWITCH) != null);

  if (twitchTenants.length === 0) {
    log.debug({ component: 'monitor' }, 'No Twitch tenants to poll');
    return { success: true };
  }

  const twitchEntries = twitchTenants
    .map((cfg) => {
      const info = requirePlatformConfig(cfg, PLATFORMS.TWITCH);
      return info ? { cfg, platformUserId: info.platformUserId } : null;
    })
    .filter((entry): entry is { cfg: TenantConfig; platformUserId: string } => entry != null);

  const tenantIds = twitchEntries.map((e) => e.cfg.id);
  const userIds = twitchEntries.map((e) => e.platformUserId);

  const streamMap = await getTwitchStreamStatusBatch(userIds);

  for (const { cfg, platformUserId } of twitchEntries) {
    await processTenantWithStreamStatus(cfg, streamMap.get(platformUserId) ?? null, liveQueue);
  }

  log.debug(
    { component: 'monitor', jobId: job.id, tenantCount: twitchTenants.length, tenants: tenantIds.join(', ') },
    'Twitch batch poll completed'
  );
  return { success: true };
}

/**
 * Per-tenant job for non-Twitch platforms (Kick, etc.)
 */
async function processPerTenantJob(job: Job<MonitorJob>, tenantId: string): Promise<{ success: true }> {
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
}

/**
 * Process a single Twitch tenant with a pre-fetched stream status.
 */
async function processTenantWithStreamStatus(
  config: TenantConfig,
  streamStatus: TwitchStreamStatus | null,
  liveQueue: ReturnType<typeof getLiveDownloadQueue>
): Promise<void> {
  const tenantId = config.id;
  const log = createAutoLogger(tenantId);
  const { db } = await getJobContext(tenantId);

  const platform = PLATFORMS.TWITCH;
  const platformInfo = requirePlatformConfig(config, platform);
  if (!platformInfo) return;

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
      return;
    }
  }

  try {
    await handlePlatformLiveCheckWithStreamStatus(db, tenantId, config, streamStatus, activeLiveVod ?? null);
  } catch (error) {
    handleWorkerError(error, log, { platform, tenantId });
  }
}

export default monitorProcessor;
