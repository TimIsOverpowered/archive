import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RedisService } from '../../utils/redis-service.js';
import { getTenantConfig } from '../../config/loader.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { notFound } from '../../utils/http-error.js';
import { getChannelBadges, getGlobalBadges } from '../../services/twitch/index.js';

interface BadgesRoutesOptions {
  prefix: string;
}

export default async function badgesRoutes(fastify: FastifyInstance, _options: BadgesRoutesOptions) {
  // Get Twitch badges for a channel (global + subscriber) with Redis caching
  fastify.get(
    '/:tenantId/badges/twitch',
    {
      schema: {
        tags: ['Badges'],
        description: 'Get Twitch badges for a channel (global + subscriber)',
        params: {
          type: 'object',
          properties: { tenantId: { type: 'string', description: 'Tenant ID' } },
          required: ['tenantId'],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { tenantId: string }; Body?: unknown }>): Promise<unknown> => {
      const tenantId = request.params.tenantId;
      const log = createAutoLogger(tenantId);

      const config = getTenantConfig(tenantId);

      if (!config?.twitch?.id) notFound('Twitch not configured for this tenant');

      const redis = RedisService.getClient();
      // Check Redis cache first (60-minute TTL)
      if (redis) {
        try {
          const cachedBadges = await redis.get(`twitch_badges:${tenantId}`);

          if (cachedBadges) {
            log.info('Returning cached Twitch badges');

            return { data: JSON.parse(cachedBadges) };
          }
        } catch {
          // Cache miss or Redis error - continue to fetch from API
        }
      }

      // Fetch from Twitch API on cache miss
      try {
        const [channelBadges, globalBadges] = await Promise.all([
          getChannelBadges(tenantId).catch(() => null),
          getGlobalBadges(tenantId).catch(() => null),
        ]);

        const badgesData = { channel: channelBadges || null, global: globalBadges || null };

        // Cache in Redis with 60-minute TTL (3600 seconds) if fetch succeeded
        if (redis) {
          try {
            await redis.set(`twitch_badges:${tenantId}`, JSON.stringify(badgesData), 'EX', 3600);
          } catch {
            // Cache write failure - still return the fetched data even if caching fails
            log.warn('Failed to cache Twitch badges in Redis, returning uncached result');
          }
        }

        log.info('Fetched and cached Twitch badges');

        return { data: badgesData };
      } catch {
        log.info('Fetched Twitch badges (cache unavailable)');

        return { data: { channel: null, global: null } };
      }
    }
  );

  return fastify;
}
