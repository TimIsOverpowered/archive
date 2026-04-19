import type { FastifyPluginAsync } from 'fastify';
import { RedisService, type RateLimiterConfig } from '../../utils/redis-service.js';
import { getLogger } from '../../utils/logger.js';
import { getApiConfig } from '../../config/env.js';

interface RedisPluginOptions {
  url: string;
}

const redisPlugin: FastifyPluginAsync<RedisPluginOptions> = async (fastify, options) => {
  const { url } = options;
  const config = getApiConfig();

  const vodLimit = config.RATE_LIMIT_VODS;
  const chatLimit = config.RATE_LIMIT_CHAT;
  const adminGetLimit = config.RATE_LIMIT_ADMIN_GET;
  const blockDuration = config.RATE_LIMIT_BLOCK_DURATION;

  const rateLimiters: RateLimiterConfig[] = [
    { keyPrefix: 'rate:vods', points: vodLimit, duration: 60 },
    { keyPrefix: 'rate:chat', points: chatLimit, duration: 60, blockDuration: blockDuration * 2 },
    { keyPrefix: 'rate:admin', points: adminGetLimit, duration: 60, blockDuration: blockDuration * 5 },
  ];

  RedisService.init({ url, rateLimiters });

  await RedisService.instance!.connect();

  // Register on Fastify instance for backward compatibility
  fastify.decorate('redis', RedisService.getClient());
  fastify.decorate('publicRateLimiter', RedisService.getLimiter('rate:vods'));
  fastify.decorate('chatRateLimiter', RedisService.getLimiter('rate:chat'));
  fastify.decorate('adminRateLimiter', RedisService.getLimiter('rate:admin'));

  getLogger().info({ vodLimit, chatLimit, adminGetLimit }, 'Rate limiters initialized');
};

export default redisPlugin;

export { RedisService };

export function getRedisStatus(): { status: string; connected: boolean } {
  return RedisService.getStatus();
}

export function getRedisClient() {
  return RedisService.getClient();
}

export async function closeRedisClient(): Promise<void> {
  await RedisService.close();
}
