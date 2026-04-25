import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { KICK_API_TIMEOUT_MS, KICK_SUBCATEGORIES_URL } from '../../constants.js';
import { LRUCache } from 'lru-cache';

const log = childLogger({ module: 'kick-category' });

export const kickCategoryCache = new LRUCache<string, Record<string, unknown>>({
  max: 500,
  ttl: 7 * 24 * 60 * 60 * 1000,
  allowStale: false,
});

export async function getKickCategoryInfo(slug: string): Promise<Record<string, unknown> | null> {
  const cached = kickCategoryCache.get(slug);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = await fetchUrl<Record<string, unknown>>(`${KICK_SUBCATEGORIES_URL}/${slug}`, {
      timeoutMs: KICK_API_TIMEOUT_MS,
    });

    if (!result.success) return null;

    const response = result.data;
    const cachedResult = response ?? null;
    if (cachedResult != null) {
      kickCategoryCache.set(slug, cachedResult);
    }
    return cachedResult;
  } catch (error) {
    log.warn({ error: extractErrorDetails(error).message, slug }, 'Failed to fetch category info');
    return null;
  }
}
