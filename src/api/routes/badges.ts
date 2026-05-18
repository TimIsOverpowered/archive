import type { FastifyInstance } from 'fastify';
import { configService } from '../../config/tenant-config.js';
import { Cache } from '../../constants.js';
import { getChannelBadges, getGlobalBadges } from '../../services/twitch/index.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { simpleKeys } from '../../utils/cache-keys.js';
import { defaultCacheContext } from '../../utils/cache.js';
import { extractErrorDetails } from '../../utils/error.js';
import { notFound } from '../../utils/http-error.js';
import createRateLimitMiddleware from '../middleware/rate-limit.js';
import { errorResponse, ok } from '../response.js';

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
      const tenantId = request.params.tenantId.toLowerCase();
      const log = createAutoLogger(tenantId);

      const config = await configService.get(tenantId);

      if (config?.twitch?.id == null) notFound('Twitch not configured for this tenant');

      const cacheKey = simpleKeys.badges(tenantId);

      try {
        const badgesData = await defaultCacheContext.withCache(cacheKey, Cache.BADGES_TTL, async () => {
          const [channelBadges, globalBadges] = await Promise.all([
            getChannelBadges(tenantId).catch(() => null),
            getGlobalBadges(tenantId).catch(() => null),
          ]);

          return { channel: channelBadges ?? null, global: globalBadges ?? null };
        });

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
