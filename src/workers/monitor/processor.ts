import type { Job, Processor } from 'bullmq';
import { configService } from '../../config/tenant-config.ts';
import type { TenantConfig } from '../../config/types.ts';
import { requirePlatformConfig } from '../../config/types.ts';
import { Http, Jobs, Monitor } from '../../constants.ts';
import { findActiveLiveVod } from '../../db/queries/vods.ts';
import { getTwitchStreamStatusBatch, type TwitchStreamStatus } from '../../services/twitch/live.ts';
import { PLATFORM_VALUES, PLATFORMS } from '../../types/platforms.ts';
import { createAutoLogger } from '../../utils/auto-tenant-logger.ts';
import { jitter } from '../../utils/delay.ts';
import { getLogger } from '../../utils/logger.ts';
import type { MonitorJob, MonitorJobResult } from '../jobs/types.ts';
import { getLiveDownloadQueue } from '../queues/queue.ts';
import { handleWorkerError } from '../utils/error-handler.ts';
import { getJobContext } from '../utils/job-context.ts';
import { handlePlatformLiveCheck, handlePlatformLiveCheckWithStreamStatus } from './live-handler.ts';

const monitorProcessor: Processor<MonitorJob, MonitorJobResult, string> = async (job: Job<MonitorJob>) => {
  const { tenantId, platform } = job.data;

  const baseInterval =
    platform === PLATFORMS.TWITCH ? Monitor.TWITCH_BATCH_POLL_INTERVAL_MS : Monitor.TENANT_POLL_INTERVAL_MS;

  const jittered = jitter(baseInterval, Monitor.POLL_JITTER_RANGE);
  const extraDelay = jittered - baseInterval;
  if (extraDelay > 0) {
    await new Promise((r) => setTimeout(r, extraDelay));
  }

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
    .filter(
      (cfg) =>
        cfg.status === 'active' &&
        cfg.settings.vodDownload === true &&
        requirePlatformConfig(cfg, PLATFORMS.TWITCH) != null
    );

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

  for (const [index, { cfg, platformUserId }] of twitchEntries.entries()) {
    if (index > 0) {
      await new Promise((r) => setTimeout(r, Http.TENANT_STAGGER_MS));
    }
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
    if (platform === PLATFORMS.TWITCH) {
      continue;
    }
    if (!requirePlatformConfig(config, platform)) {
      continue;
    }

    const activeLiveVod = await findActiveLiveVod(db, platform);

    if (activeLiveVod && activeLiveVod.platform_vod_id != null && activeLiveVod.platform_vod_id !== '') {
      const jobId = `${Jobs.LIVE_HLS_JOB_PREFIX}${tenantId}_${activeLiveVod.platform_vod_id}`;
      const queuedJob = await liveQueue.getJob(jobId);
      if (queuedJob !== undefined) {
        const [isActive, isWaiting, isDelayed] = await Promise.all([
          queuedJob.isActive(),
          queuedJob.isWaiting(),
          queuedJob.isDelayed(),
        ]);
        if (isActive || isWaiting || isDelayed) {
          log.debug(
            { component: 'monitor', platform, vodId: activeLiveVod.platform_vod_id },
            'Skipping - live worker job still in queue'
          );
          continue;
        }
      }
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
    const jobId = `${Jobs.LIVE_HLS_JOB_PREFIX}${tenantId}_${activeLiveVod.platform_vod_id}`;
    const queuedJob = await liveQueue.getJob(jobId);
    if (queuedJob !== undefined) {
      const [isActive, isWaiting, isDelayed] = await Promise.all([
        queuedJob.isActive(),
        queuedJob.isWaiting(),
        queuedJob.isDelayed(),
      ]);
      if (isActive || isWaiting || isDelayed) {
        log.debug(
          { component: 'monitor', platform, vodId: activeLiveVod.platform_vod_id },
          'Skipping - live worker job still in queue'
        );
        return;
      }
    }
  }

  try {
    await handlePlatformLiveCheckWithStreamStatus(db, tenantId, config, streamStatus, activeLiveVod ?? null);
  } catch (error) {
    handleWorkerError(error, log, { platform, tenantId });
  }
}

export default monitorProcessor;
