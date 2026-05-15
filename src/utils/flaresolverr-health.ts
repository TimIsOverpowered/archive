import { LRUCache } from 'lru-cache';
import { getBaseConfig } from '../config/env.js';
import { Flaresolverr } from '../constants.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from './logger.js';

interface FlareSolverrStatusResponse {
  status: string;
  version: string;
  sessions?: string[];
}

const healthCache = new LRUCache<string, FlareSolverrStatusResponse>({
  max: 1,
  ttl: Flaresolverr.HEALTH_CACHE_TTL_MS,
  allowStale: false,
});

export async function checkFlareSolverrHealth(): Promise<FlareSolverrStatusResponse> {
  const cached = healthCache.get('health');
  if (cached) {
    return cached;
  }

  try {
    const baseURL = getBaseConfig().FLARESOLVERR_BASE_URL;
    const signal = AbortSignal.timeout(Flaresolverr.TIMEOUT_MS);

    const response = await fetch(`${baseURL}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'sessions.list' }),
      signal,
    });

    const body = (await response.json()) as FlareSolverrStatusResponse;

    if (body.status !== 'ok') {
      const result: FlareSolverrStatusResponse = { status: 'error', version: 'unknown' };
      healthCache.set('health', result);
      getLogger().error({ component: 'flaresolverr-health' }, 'Status report is not ok');
      return result;
    }

    healthCache.set('health', body);
    return body;
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().warn({ component: 'flaresolverr-health', ...details }, 'Failed to check health (transient error)');

    const result: FlareSolverrStatusResponse = { status: 'error', version: 'unknown' };

    healthCache.set('health', result);
    return result;
  }
}
