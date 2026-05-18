import { LRUCache } from 'lru-cache';
import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { childLogger } from '../../utils/logger.js';
import { KickCategoryInfo } from './live.js';

const log = childLogger({ module: 'kick-category' });

const kickCategoryCache = new LRUCache<string, KickCategoryInfo>({
  max: 500,
  ttl: 7 * 24 * 60 * 60 * 1000,
  allowStale: false,
});

export async function getKickCategoryInfo(slug: string): Promise<KickCategoryInfo | null> {
  const cached = kickCategoryCache.get(slug);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = await fetchUrl<KickCategoryInfo>(`${Kick.SUBCATEGORIES_URL}/${slug}`, {
      timeoutMs: Kick.API_TIMEOUT_MS,
    });

    if (!result.success) return null;

    kickCategoryCache.set(slug, result.data);
    return result.data;
  } catch (error) {
    log.warn({ error: extractErrorDetails(error).message, slug }, 'Failed to fetch category info');
    return null;
  }
}
