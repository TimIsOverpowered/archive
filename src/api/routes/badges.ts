import type { FastifyInstance, FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import { getTenantConfig } from '../../config/loader';
import { extractErrorDetails } from '../../utils/error.js';

interface BadgesRoutesOptions {
  prefix: string;
}

export default async function badgesRoutes(fastify: FastifyInstance, _options: BadgesRoutesOptions) {
  // Get Twitch badges for a channel (global + subscriber) with Redis caching
  fastify.get(
    '/:id/badges/twitch',
    {
      schema: {
        tags: ['Badges'],
        description: 'Get Twitch badges for a channel (global + subscriber)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body?: unknown }>): Promise<unknown> => {
      const tenantId = request.params.id;

      try {
        const config = getTenantConfig(tenantId);

        if (!config?.twitch?.id) throw new Error('Twitch not configured for this tenant');

        // Check Redis cache first (60-minute TTL)
        const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

        try {
          const cachedBadges = await redisInstance.get(`twitch_badges:${tenantId}`);

          if (cachedBadges) {
            request.log.info(`[${tenantId}] Returning cached Twitch badges`);

            return { data: JSON.parse(cachedBadges) };
          }
        } catch {
          // Cache miss or Redis error - continue to fetch from API
        }

        // Fetch from Twitch API on cache miss
        const twitch = await import('../../services/twitch');

        try {
          const [channelBadges, globalBadges] = await Promise.all([twitch.getChannelBadges(tenantId).catch(() => null), twitch.getGlobalBadges(tenantId).catch(() => null)]);

          const badgesData = { channel: channelBadges || null, global: globalBadges || null };

          // Cache in Redis with 60-minute TTL (3600 seconds) if fetch succeeded
          try {
            await redisInstance.set(`twitch_badges:${tenantId}`, JSON.stringify(badgesData), 'EX', 3600);

            request.log.info(`[${tenantId}] Fetched and cached Twitch badges`);

            return { data: badgesData };
          } catch {
            // Cache write failure - still return the fetched data even if caching fails
            request.log.warn(`Failed to cache Twitch badges in Redis, returning uncached result for ${tenantId}`);

            return { data: badgesData };
          }
        } finally {
          await redisInstance.quit().catch(() => {}); // Graceful disconnect - ignore errors
        }
      } catch (error) {
        const details = extractErrorDetails(error);
        request.log.error({ ...details, tenantId }, 'Failed to fetch Twitch badges');

        throw new Error('Something went wrong trying to retrieve channel badges..');
      }
    }
  );

  return fastify;
}
