import { configService } from '../../config/tenant-config.js';
import type { TenantConfig } from '../../config/types.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { getMonitorQueue } from '../queues/queue.js';

export async function registerMonitorRepeatJob(config: TenantConfig): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor:${config.id}`;

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

export async function registerAllMonitorRepeatJobs(): Promise<void> {
  getLogger().info({ component: 'monitor' }, 'Registering monitor repeat jobs for all tenants...');

  const configs = getTenantConfigsForMonitoring();

  if (configs.length === 0) {
    getLogger().warn({ component: 'monitor' }, 'No tenants with VOD download enabled found');
    return;
  }

  const jobs = configs.map((config) => registerMonitorRepeatJob(config));
  await Promise.all(jobs);

  getLogger().info({ count: configs.length }, 'Registered monitor repeat jobs');
}

export async function removeMonitorRepeatJob(tenantId: string): Promise<void> {
  const queue = getMonitorQueue();
  const jobId = `monitor:${tenantId}`;

  try {
    await queue.removeJobScheduler(jobId);
    getLogger().info({ component: 'monitor', tenantId }, 'Removed repeat job');
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ component: 'monitor', tenantId, ...details }, 'Failed to remove repeat job (may not exist)');
  }
}

function getTenantConfigsForMonitoring(): TenantConfig[] {
  return configService.getAll().filter((config) => config.settings.vodDownload === true);
}
