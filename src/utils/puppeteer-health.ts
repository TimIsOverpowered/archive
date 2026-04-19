import type { Browser } from 'puppeteer';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';
import { getFullMemoryStats, releaseBrowser, type MemoryStats } from './puppeteer-manager.js';
import { PUPPETEER_HEALTH_CACHE_TTL_MS } from '../constants.js';
import { LRUCache } from 'lru-cache';

type HealthStatus = 'ok' | 'elevated' | 'high_memory' | 'unavailable';

interface PuppeteerHealthStatus {
  status: HealthStatus;
  stats?: MemoryStats;
}

const healthCache = new LRUCache<string, PuppeteerHealthStatus>({
  max: 1,
  ttl: PUPPETEER_HEALTH_CACHE_TTL_MS,
  allowStale: false,
});

export async function checkPuppeteerHealth(browserInstance?: Browser): Promise<PuppeteerHealthStatus> {
  const cached = healthCache.get('health');
  if (cached) {
    return cached;
  }

  try {
    const memStats = await getFullMemoryStats(browserInstance);

    // Use RSS for Docker OOM prevention (most honest total RAM metric)
    const limitMb = parseInt(process.env.PUPPETEER_MEMORY_LIMIT_MB || '512', 10);
    const warningThresholdPct = parseInt(process.env.PUPPETEER_WARNING_THRESHOLD_PCT || '85', 10);
    const softLimitMb = Math.floor(limitMb * (warningThresholdPct / 100));

    // Three-tier logic based on memory usage
    if (memStats.totalRssMb > limitMb) {
      const status: PuppeteerHealthStatus = { status: 'high_memory', stats: memStats };
      healthCache.set('health', status);
      logger.error(
        { ...memStats, limitMb },
        '[Puppeteer Health] CRITICAL: Hard memory limit exceeded - immediate restart required'
      );
      return status;
    } else if (memStats.totalRssMb > softLimitMb) {
      const status: PuppeteerHealthStatus = { status: 'elevated', stats: memStats };
      healthCache.set('health', status);
      logger.warn(
        { ...memStats, softLimitMb, limitMb },
        '[Puppeteer Health] Elevated memory usage - consider restart before next task'
      );
      return status;
    } else {
      const status: PuppeteerHealthStatus = { status: 'ok', stats: memStats };
      healthCache.set('health', status);
      return status;
    }
  } catch (error) {
    const details = extractErrorDetails(error);

    // Check if this is a disconnection error requiring browser reset
    const errorMsg = String(details.message || '').toLowerCase();
    const isDisconnectionError =
      errorMsg.includes('target closed') ||
      errorMsg.includes('browser disconnected') ||
      errorMsg.includes('protocol error');

    if (isDisconnectionError) {
      logger.error(
        { ...details, requiresRestart: true },
        '[Puppeteer Health] Browser process dead - releasing instance for restart'
      );

      // Clear the zombie browser globally to force fresh initialization on next getBrowser() call
      await releaseBrowser();
    } else {
      logger.warn(details, '[Puppeteer Health] Failed to check health (transient error)');
    }

    const status: PuppeteerHealthStatus = { status: 'unavailable' };
    healthCache.set('health', status);
    return status;
  }
}
