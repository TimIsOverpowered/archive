import { getLogger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { registerAllMonitorRepeatJobs, removeMonitorRepeatJob } from './startup.js';

export async function startMonitorService(): Promise<void> {
  getLogger().info('[Monitor] Starting Archive Monitor Service...');

  try {
    await registerAllMonitorRepeatJobs();
    getLogger().info('[Monitor] Started monitor repeat jobs');
  } catch (error: unknown) {
    const details = extractErrorDetails(error);
    getLogger().error(details, '[Monitor] Failed to start monitor service');
    process.exit(1);
  }
}

export async function stopMonitorService(): Promise<void> {
  getLogger().info('[Monitor] Received shutdown signal. Cleaning up...');

  getLogger().info('[Monitor] Shutdown complete.');
}

export { removeMonitorRepeatJob };
