import pLimit from 'p-limit';
import { getWorkersConfig } from '../config/env.js';

const limit = pLimit(getWorkersConfig().PUPPETEER_CONCURRENCY);

export { limit };

export function getPuppeteerQueueStats() {
  return {
    active: limit.activeCount,
    pending: limit.pendingCount,
  };
}
