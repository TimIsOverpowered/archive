import type { Browser } from 'puppeteer';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';
import { getFullMemoryStats, releaseBrowser, type MemoryStats } from './puppeteer-manager.js';

type HealthStatus = 'ok' | 'elevated' | 'high_memory' | 'unavailable';

interface PuppeteerHealthStatus {
  status: HealthStatus;
  stats?: MemoryStats;
}

let cachedStatus: PuppeteerHealthStatus | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000; // Cache for 30 seconds

export async function checkPuppeteerHealth(browserInstance?: Browser): Promise<PuppeteerHealthStatus> {
  const now = Date.now();

  if (cachedStatus && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }

  try {
    const memStats = await getFullMemoryStats(browserInstance);

    // Use RSS for Docker OOM prevention (most honest total RAM metric)
    const limitMb = parseInt(process.env.PUPPETEER_MEMORY_LIMIT_MB || '512', 10);
    const warningThresholdPct = parseInt(process.env.PUPPETEER_WARNING_THRESHOLD_PCT || '85', 10);
    const softLimitMb = Math.floor(limitMb * (warningThresholdPct / 100));

    // Three-tier logic based on memory usage
    if (memStats.totalRssMb > limitMb) {
      cachedStatus = { status: 'high_memory', stats: memStats };
      logger.error({ ...memStats, limitMb }, '[Puppeteer Health] CRITICAL: Hard memory limit exceeded - immediate restart required');
    } else if (memStats.totalRssMb > softLimitMb) {
      cachedStatus = { status: 'elevated', stats: memStats };
      logger.warn({ ...memStats, softLimitMb, limitMb }, '[Puppeteer Health] Elevated memory usage - consider restart before next task');
    } else {
      cachedStatus = { status: 'ok', stats: memStats };
    }

    cacheTimestamp = now;
    return cachedStatus;
  } catch (error) {
    const details = extractErrorDetails(error);

    // Check if this is a disconnection error requiring browser reset
    const errorMsg = String(details.message || '').toLowerCase();
    const isDisconnectionError = errorMsg.includes('target closed') || errorMsg.includes('browser disconnected') || errorMsg.includes('protocol error');

    if (isDisconnectionError) {
      logger.error({ ...details, requiresRestart: true }, '[Puppeteer Health] Browser process dead - releasing instance for restart');

      // Clear the zombie browser globally to force fresh initialization on next getBrowser() call
      await releaseBrowser();
    } else {
      logger.warn(details, '[Puppeteer Health] Failed to check health (transient error)');
    }

    cachedStatus = { status: 'unavailable' };
    cacheTimestamp = now;
    return cachedStatus;
  }
}

export function clearPuppeteerHealthCache(): void {
  cachedStatus = null;
  cacheTimestamp = 0;
}
