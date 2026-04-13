import pLimit from 'p-limit';

const CONCURRENCY = parseInt(process.env.PUPPETEER_CONCURRENCY || '3', 10);
const limit = pLimit(CONCURRENCY);

export { limit };

export function getPuppeteerQueueStats() {
  return {
    active: limit.activeCount,
    pending: limit.pendingCount,
  };
}
