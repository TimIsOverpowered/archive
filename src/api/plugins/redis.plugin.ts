import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { getApiConfig } from '../../config/env.js';
import { RateLimiter } from '../../types/global.js';
import { getLogger } from '../../utils/logger.js';
import { RedisService, type RateLimiterConfig } from '../../utils/redis-service.js';

interface RedisPluginOptions {
  url: string;
}

const redisPlugin: FastifyPluginAsync<RedisPluginOptions> = async (fastify, options) => {
  const { url } = options;
  const config = getApiConfig();

  const vodLimit = config.RATE_LIMIT_VODS;
  const chatLimit = config.RATE_LIMIT_CHAT;
  const adminGetLimit = config.RATE_LIMIT_ADMIN_GET;
  const adminAuthLimit = config.RATE_LIMIT_ADMIN_AUTH;
  const blockDuration = config.RATE_LIMIT_BLOCK_DURATION;

  const rateLimiters: RateLimiterConfig[] = [
    { keyPrefix: 'rate:vods', points: vodLimit, duration: 60 },
    { keyPrefix: 'rate:chat', points: chatLimit, duration: 60, blockDuration: blockDuration * 2 },
    { keyPrefix: 'rate:admin', points: adminGetLimit, duration: 60, blockDuration: blockDuration * 5 },
    { keyPrefix: 'rate:admin:auth', points: adminAuthLimit, duration: 1 },
  ];

  await RedisService.init({ url, rateLimiters }).connect();

  fastify.decorate('redis', RedisService.getClient());
  fastify.decorate<RateLimiter>('publicRateLimiter', RedisService.requireLimiter('rate:vods'));
  fastify.decorate<RateLimiter>('chatRateLimiter', RedisService.requireLimiter('rate:chat'));
  fastify.decorate<RateLimiter>('adminRateLimiter', RedisService.requireLimiter('rate:admin'));

  getLogger().info({ vodLimit, chatLimit, adminGetLimit }, 'Rate limiters initialized');
};

export default fp(redisPlugin);

export { RedisService };

export async function closeRedisClient(): Promise<void> {
  await RedisService.close();
}
