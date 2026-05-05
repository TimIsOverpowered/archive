import { configService } from '../../config/tenant-config.js';
import type { TenantConfig } from '../../config/types.js';
import { requirePlatformConfig } from '../../config/types.js';
import { Monitor } from '../../constants.js';
import { PLATFORMS } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { getMonitorQueue } from '../queues/queue.js';

export async function registerMonitorRepeatJob(config: TenantConfig): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor_${config.id}`;

  try {
    await queue.add(
      'check',
      { tenantId: config.id },
      {
        jobId,
        repeat: { every: 30_000, immediately: true },
        deduplication: { id: jobId },
      }
    );
    getLogger().info({ component: 'monitor', jobId, tenantId: config.id }, 'Registered repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error(
      { component: 'monitor', jobId, tenantId: config.id, ...details },
      'Failed to register repeat job'
    );
  }
}

/**
 * Register a single shared job that batch-polls all Twitch-enabled tenants.
 */
async function registerTwitchBatchMonitorJob(): Promise<void> {
  const queue = getMonitorQueue();

  try {
    await queue.add(
      'check',
      { tenantId: '__twitch_batch__', batchType: 'twitch' },
      {
        jobId: Monitor.TWITCH_BATCH_JOB_ID,
        repeat: { every: 30_000, immediately: true },
        deduplication: { id: Monitor.TWITCH_BATCH_JOB_ID },
      }
    );
    getLogger().info(
      { component: 'monitor', jobId: Monitor.TWITCH_BATCH_JOB_ID },
      'Registered Twitch batch repeat job'
    );
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error(
      { component: 'monitor', jobId: Monitor.TWITCH_BATCH_JOB_ID, ...details },
      'Failed to register Twitch batch repeat job'
    );
  }
}

export async function registerAllMonitorRepeatJobs(): Promise<void> {
  getLogger().info({ component: 'monitor' }, 'Registering monitor repeat jobs for all tenants...');

  const configs = getTenantConfigsForMonitoring();

  if (configs.length === 0) {
    getLogger().warn({ component: 'monitor' }, 'No tenants with VOD download enabled found');
    return;
  }

  const twitchTenants = configs.filter((cfg) => requirePlatformConfig(cfg, PLATFORMS.TWITCH) != null);
  const nonTwitchTenants = configs.filter((cfg) => requirePlatformConfig(cfg, PLATFORMS.TWITCH) == null);

  if (twitchTenants.length > 0) {
    await registerTwitchBatchMonitorJob();
  }

  const perTenantJobs = nonTwitchTenants.map((config) => registerMonitorRepeatJob(config));
  await Promise.all(perTenantJobs);

  getLogger().info(
    { twitchBatch: twitchTenants.length, perTenant: nonTwitchTenants.length },
    'Registered monitor repeat jobs'
  );
}

export async function removeMonitorRepeatJob(tenantId: string): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor_${tenantId}`;

  try {
    await queue.removeJobScheduler(jobId);
    getLogger().info({ component: 'monitor', tenantId }, 'Removed repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ component: 'monitor', tenantId, ...details }, 'Failed to remove repeat job (may not exist)');
  }
}

/**
 * Remove the shared Twitch batch monitor job.
 */
export async function removeTwitchBatchMonitorJob(): Promise<void> {
  const queue = getMonitorQueue();

  try {
    await queue.removeJobScheduler(Monitor.TWITCH_BATCH_JOB_ID);
    getLogger().info({ component: 'monitor', jobId: Monitor.TWITCH_BATCH_JOB_ID }, 'Removed Twitch batch repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn(
      { component: 'monitor', jobId: Monitor.TWITCH_BATCH_JOB_ID, ...details },
      'Failed to remove Twitch batch repeat job (may not exist)'
    );
  }
}

function getTenantConfigsForMonitoring(): TenantConfig[] {
  return configService.getAll().filter((config) => config.settings.vodDownload === true);
}
