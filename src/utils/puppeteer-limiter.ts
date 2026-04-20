import pLimit from 'p-limit';
import { getPuppeteerConcurrency } from '../config/env-accessors.js';

const limit = pLimit(getPuppeteerConcurrency());

export { limit };

export function getPuppeteerQueueStats() {
  return {
    active: limit.activeCount,
    pending: limit.pendingCount,
  };
}
