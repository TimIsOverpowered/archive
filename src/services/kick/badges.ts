import { LRUCache } from 'lru-cache';
import { configService } from '../../config/tenant-config.js';
import { Kick } from '../../constants.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';

const log = createAutoLogger('kick-badges');

const kickBadgesCache = new LRUCache<string, Record<string, string>>({
  max: 100,
  ttl: 60 * 60 * 1000,
  allowStale: false,
});

export async function getKickChannelBadges(tenantId: string): Promise<Record<string, string> | null> {
  const cached = kickBadgesCache.get(tenantId);
  if (cached !== undefined) {
    return cached;
  }

  const config = await configService.get(tenantId);
  if (config?.kick?.username == null || config.kick.username === '') {
    log.warn({ tenantId }, 'Kick username not configured for streamer');
    return null;
  }

  try {
    const url = `${Kick.API_BASE}/api/v2/channels/${config.kick.username}`;
    const result = await fetchUrl<{ subscriber_badges?: Array<{ months?: number; badge_image?: { src?: string } }> }>(
      url,
      { timeoutMs: Kick.API_TIMEOUT_MS }
    );

    if (!result.success || !result.data?.subscriber_badges) {
      return null;
    }

    const badgeMap: Record<string, string> = {};
    for (const badge of result.data.subscriber_badges) {
      if (badge.months != null && badge.badge_image?.src) {
        badgeMap[String(badge.months)] = badge.badge_image.src;
      }
    }

    kickBadgesCache.set(tenantId, badgeMap);
    return badgeMap;
  } catch (error: unknown) {
    log.error({ tenantId, error: extractErrorDetails(error).message }, 'Failed to fetch Kick channel badges');
    return null;
  }
}
