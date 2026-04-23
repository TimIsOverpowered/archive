import { extractErrorDetails } from './error.js';
import { getLogger } from './logger.js';
import { getBaseConfig } from '../config/env.js';
import { FLARESOLVERR_HEALTH_CACHE_TTL_MS } from '../constants.js';
import { LRUCache } from 'lru-cache';

export interface FlareSolverrHealthStats {
  version: string;
  sessions: number;
}

export interface FlareSolverrHealthResult {
  status: 'ok' | 'error';
  stats: FlareSolverrHealthStats;
}

interface FlareSolverrStatusResponse {
  status: 'ok';
  version: string;
  sessions?: number;
}

const healthCache = new LRUCache<string, FlareSolverrHealthResult>({
  max: 1,
  ttl: FLARESOLVERR_HEALTH_CACHE_TTL_MS,
  allowStale: false,
});

export async function checkFlareSolverrHealth(): Promise<FlareSolverrHealthResult> {
  const cached = healthCache.get('health');
  if (cached) {
    return cached;
  }

  try {
    const baseURL = getBaseConfig().FLARESOLVERR_BASE_URL;
    const response = await fetch(`${baseURL}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'status' }),
    });

    const body: FlareSolverrStatusResponse = await response.json();

    if (body.status !== 'ok') {
      const result: FlareSolverrHealthResult = { status: 'error', stats: { version: 'unknown', sessions: 0 } };
      healthCache.set('health', result);
      getLogger().error({ component: 'flaresolverr-health' }, 'Status report is not ok');
      return result;
    }

    const result: FlareSolverrHealthResult = {
      status: 'ok',
      stats: {
        version: body.version,
        sessions: body.sessions ?? 0,
      },
    };

    healthCache.set('health', result);
    return result;
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ component: 'flaresolverr-health', ...details }, 'Failed to check health (transient error)');

    const result: FlareSolverrHealthResult = {
      status: 'error',
      stats: { version: 'unknown', sessions: 0 },
    };

    healthCache.set('health', result);
    return result;
  }
}
