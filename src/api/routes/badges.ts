import type { FastifyInstance } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import { getChannelBadges, getGlobalBadges } from '../../services/twitch/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { notFound } from '../../utils/http-error.js';
import { RedisService } from '../../utils/redis-service.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { ok, errorResponse } from '../response.js';

/** Options for registering the badges routes plugin. */
interface BadgesRoutesOptions {
  prefix: string;
}

/**
 * Register badges routes: fetch Twitch channel + global badges with Redis caching.
 * Requires rate limiting.
 */
export default function badgesRoutes(fastify: FastifyInstance, _options: BadgesRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.publicRateLimiter,
  });

  // Get Twitch badges for a channel (global + subscriber) with Redis caching
  fastify.get<{ Params: { tenantId: string } }>(
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
    async (request, reply) => {
      const tenantId = request.params.tenantId;
      const log = createAutoLogger(tenantId);

      const config = configService.get(tenantId);

      if (config?.twitch?.id == null) notFound('Twitch not configured for this tenant');

      const redis = RedisService.getActiveClient();
      // Check Redis cache first (60-minute TTL)
      if (redis) {
        try {
          const cachedBadges = await redis.get(`twitch_badges:${tenantId}`);

          if (cachedBadges != null) {
            log.info('Returning cached Twitch badges');

            return ok(JSON.parse(cachedBadges) as Record<string, unknown>);
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

        const badgesData = { channel: channelBadges ?? null, global: globalBadges ?? null };

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

        return ok(badgesData);
      } catch (err) {
        const details = extractErrorDetails(err);
        log.error({ err: details }, 'Failed to fetch Twitch badges');

        return reply.status(502).send(errorResponse(502, 'Failed to fetch badges from Twitch', 'BADGES_FETCH_FAILED'));
      }
    }
  );

  return fastify;
}
