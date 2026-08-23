import type { FastifyInstance } from 'fastify';
import { configService } from '../../config/tenant-config.ts';
import { Cache } from '../../constants.ts';
import { getKickChannelBadges } from '../../services/kick/index.ts';
import { getChannelBadges, getGlobalBadges } from '../../services/twitch/index.ts';
import { createAutoLogger } from '../../utils/auto-tenant-logger.ts';
import { defaultCacheContext } from '../../utils/cache.ts';
import { simpleKeys } from '../../utils/cache-keys.ts';
import { extractErrorDetails } from '../../utils/error.ts';
import { notFound } from '../../utils/http-error.ts';
import createRateLimitMiddleware from '../middleware/rate-limit.ts';
import { errorResponse, ok } from '../response.ts';

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

          const result = { channel: channelBadges ?? null, global: globalBadges ?? null };
          if (result.channel == null && result.global == null) return null;
          return result;
        });

        return ok(badgesData);
      } catch (err) {
        const details = extractErrorDetails(err);
        log.error({ err: details }, 'Failed to fetch Twitch badges');

        return reply.status(502).send(errorResponse(502, 'Failed to fetch badges from Twitch', 'BADGES_FETCH_FAILED'));
      }
    }
  );

  // Get Kick subscriber badges for a channel with Redis caching
  fastify.get<{ Params: { tenantId: string } }>(
    '/:tenantId/badges/kick',
    {
      schema: {
        tags: ['Badges'],
        description: 'Get Kick subscriber badges for a channel',
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

      if (config?.kick?.username == null) notFound('Kick not configured for this tenant');

      const cacheKey = simpleKeys.badges(`${tenantId}:kick`);

      try {
        const badgesData = await defaultCacheContext.withCache(cacheKey, Cache.BADGES_TTL, async () => {
          const channelBadges = await getKickChannelBadges(tenantId).catch(() => null);
          if (channelBadges == null) return null;
          return { subscriber: channelBadges };
        });

        return ok(badgesData);
      } catch (err) {
        const details = extractErrorDetails(err);
        log.error({ err: details }, 'Failed to fetch Kick badges');

        return reply.status(502).send(errorResponse(502, 'Failed to fetch badges from Kick', 'BADGES_FETCH_FAILED'));
      }
    }
  );

  return fastify;
}
