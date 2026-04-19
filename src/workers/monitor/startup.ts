import { getConfigs } from '../../config/loader.js';
import type { TenantConfig } from '../../config/types.js';
import { getMonitorQueue } from '../jobs/queues.js';
import { logger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';

export async function registerMonitorRepeatJob(config: TenantConfig): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor:${config.id}`;

  try {
    await queue.add(
      'check',
      { tenantId: config.id },
      {
        jobId,
        repeat: { every: 30_000 },
        deduplication: { id: jobId },
      }
    );
    logger.info({ jobId, tenantId: config.id }, '[Monitor] Registered repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ jobId, tenantId: config.id, ...details }, '[Monitor] Failed to register repeat job');
  }
}

export async function registerAllMonitorRepeatJobs(): Promise<void> {
  logger.info('[Monitor] Registering monitor repeat jobs for all tenants...');

  const configs = getTenantConfigsForMonitoring();

  if (configs.length === 0) {
    logger.warn('[Monitor] No tenants with VOD download enabled found');
    return;
  }

  const jobs = configs.map((config) => registerMonitorRepeatJob(config));
  await Promise.all(jobs);

  logger.info(`[Monitor] Registered ${configs.length} monitor repeat job(s)`);
}

export async function removeMonitorRepeatJob(tenantId: string): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor:${tenantId}`;

  try {
    await queue.removeRepeatableByKey(jobId);
    logger.info({ tenantId }, '[Monitor] Removed repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.warn({ tenantId, ...details }, '[Monitor] Failed to remove repeat job (may not exist)');
  }
}

function getTenantConfigsForMonitoring(): TenantConfig[] {
  return getConfigs().filter((config) => config.settings.vodDownload);
}
