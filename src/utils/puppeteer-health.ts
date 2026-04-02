import { extractErrorDetails } from './error.js';
import { logger } from './logger';
import { getFullMemoryStats, type MemoryStats } from './puppeteer-manager.js';

interface PuppeteerHealthStatus {
  status: 'ok' | 'unavailable' | 'high_memory';
  stats?: MemoryStats;
}

let cachedStatus: PuppeteerHealthStatus | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000; // Cache for 30 seconds

export async function checkPuppeteerHealth(browserInstance?: any): Promise<PuppeteerHealthStatus> {
  const now = Date.now();

  if (cachedStatus && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }

  try {
    const memStats: MemoryStats = await getFullMemoryStats(browserInstance);

    // Use RSS for Docker OOM prevention (most honest total RAM metric)
    const limitMb = parseInt(process.env.KICK_PUPPETEER_MEMORY_LIMIT_MB || '512', 10);

    if (memStats.totalRssMb > limitMb) {
      cachedStatus = {
        status: 'high_memory',
        stats: memStats,
      };

      logger.warn({ ...memStats, limitMb }, '[Puppeteer Health] Memory usage exceeds threshold');
    } else {
      cachedStatus = {
        status: 'ok',
        stats: memStats,
      };
    }

    cacheTimestamp = now;
    return cachedStatus;
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.warn(details, '[Puppeteer Health] Failed to check health');

    cachedStatus = { status: 'unavailable' };
    cacheTimestamp = now;
    return cachedStatus;
  }
}

export function clearPuppeteerHealthCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
}
