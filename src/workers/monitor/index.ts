import { extractErrorDetails } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { registerAllMonitorRepeatJobs, removeMonitorRepeatJob, removeTwitchBatchMonitorJob } from './startup.js';

export async function startMonitorService(): Promise<void> {
  getLogger().info({ component: 'monitor' }, 'Starting Archive Monitor Service...');

  try {
    await registerAllMonitorRepeatJobs();
    getLogger().info({ component: 'monitor' }, 'Started monitor repeat jobs');
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    getLogger().error({ component: 'monitor', ...details }, 'Failed to start monitor service');
    process.exit(1);
  }
}

export function stopMonitorService(): void {
  // Repeat jobs are persisted in Redis and re-registered on next startup.
  // No explicit cleanup is needed here.
  getLogger().info({ component: 'monitor' }, 'Monitor service stopped.');
}

export { removeMonitorRepeatJob, removeTwitchBatchMonitorJob };
