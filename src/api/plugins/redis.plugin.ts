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
  const adminAuthLimit = config.RATE_LIMIT_ADMIN_AUTH;
  const blockDuration = config.RATE_LIMIT_BLOCK_DURATION;

  const rateLimiters: RateLimiterConfig[] = [
    { keyPrefix: 'rate:vods', points: vodLimit, duration: 60 },
    { keyPrefix: 'rate:chat', points: chatLimit, duration: 60, blockDuration: blockDuration * 2 },
    { keyPrefix: 'rate:admin', points: adminGetLimit, duration: 60, blockDuration: blockDuration * 5 },
    { keyPrefix: 'rate:admin:auth', points: adminAuthLimit, duration: 1 },
  ];

  await RedisService.init({ url, rateLimiters }).connect();

  // Register on Fastify instance for backward compatibility
  fastify.decorate('redis', RedisService.getClient());
  const vodsLimiter = RedisService.getLimiter('rate:vods');
  const chatLimiter = RedisService.getLimiter('rate:chat');
  const adminLimiter = RedisService.getLimiter('rate:admin');
  if (vodsLimiter && chatLimiter && adminLimiter) {
    fastify.decorate('publicRateLimiter', vodsLimiter);
    fastify.decorate('chatRateLimiter', chatLimiter);
    fastify.decorate('adminRateLimiter', adminLimiter);
  }

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
