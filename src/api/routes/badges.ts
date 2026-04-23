import type { FastifyInstance, FastifyRequest } from 'fastify';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { RedisService } from '../../utils/redis-service.js';
import { getTenantConfig } from '../../config/loader.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { notFound } from '../../utils/http-error.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getChannelBadges, getGlobalBadges } from '../../services/twitch/index.js';

interface BadgesRoutesOptions {
  prefix: string;
}

export default async function badgesRoutes(fastify: FastifyInstance, _options: BadgesRoutesOptions) {
  const badgesRateLimiter = RedisService.getLimiter('rate:vods');
  if (!badgesRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: badgesRateLimiter,
  });

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
      onRequest: [rateLimitMiddleware],
    },
    async (request: FastifyRequest<{ Params: { tenantId: string }; Body?: unknown }>): Promise<unknown> => {
      const tenantId = request.params.tenantId;
      const log = createAutoLogger(tenantId);

      const config = getTenantConfig(tenantId);

      if (!config?.twitch?.id) throw notFound('Twitch not configured for this tenant');

      const redis = RedisService.getActiveClient();
      // Check Redis cache first (60-minute TTL)
      if (redis) {
        try {
          const cachedBadges = await redis.get(`twitch_badges:${tenantId}`);

          if (cachedBadges) {
            log.info('Returning cached Twitch badges');

            return { data: JSON.parse(cachedBadges) };
          }
        } catch (err) {
          const details = extractErrorDetails(err);
          log.warn({ err: details }, 'Redis cache read failed for Twitch badges, continuing to API fetch');
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
      } catch (err) {
        const details = extractErrorDetails(err);
        log.error({ err: details }, 'Failed to fetch Twitch badges');

        return { data: { channel: null, global: null } };
      }
    }
  );

  return fastify;
}
