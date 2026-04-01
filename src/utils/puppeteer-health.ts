import { extractErrorDetails } from './error.js';
import { logger } from './logger';

interface PuppeteerHealthStatus {
  status: 'ok' | 'unavailable' | 'high_memory';
  instanceMemoryMb?: number;
}

let cachedStatus: PuppeteerHealthStatus | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000; // Cache for 30 seconds

export async function checkPuppeteerHealth(): Promise<PuppeteerHealthStatus> {
  const now = Date.now();

  if (cachedStatus && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }

  try {
    const memoryUsage = process.memoryUsage();
    const memoryMb = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const limitMb = parseInt(process.env.KICK_PUPPETEER_MEMORY_LIMIT_MB || '512', 10);

    if (memoryMb > limitMb) {
      cachedStatus = {
        status: 'high_memory',
        instanceMemoryMb: memoryMb,
      };
    } else {
      cachedStatus = {
        status: 'ok',
        instanceMemoryMb: memoryMb,
      };
    }

    cacheTimestamp = now;
    return cachedStatus;
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.warn(details, 'Failed to check Puppeteer health');
    cachedStatus = { status: 'unavailable' };
    cacheTimestamp = now;
    return cachedStatus;
  }
}

export function clearPuppeteerHealthCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
}
