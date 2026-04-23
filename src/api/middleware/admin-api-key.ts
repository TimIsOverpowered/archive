import { FastifyRequest, FastifyReply } from 'fastify';
import { findAdminByApiKey } from '../../services/admin.service.js';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { RedisService } from '../../utils/redis-service.js';
import { getLogger } from '../../utils/logger.js';

export interface AdminContext {
  adminId: number;
  username: string;
}

const createAdminAuthLimiter = (): RateLimiterRedis | RateLimiterMemory => {
  const redis = RedisService.getActiveClient();
  if (!redis) {
    return new RateLimiterMemory({ points: 20, duration: 1 });
  }
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rate:admin:auth',
    points: 20,
    duration: 1,
  });
};

let _adminAuthLimiter: RateLimiterRedis | RateLimiterMemory | null = null;

const getAdminAuthLimiter = (): RateLimiterRedis | RateLimiterMemory => {
  if (!_adminAuthLimiter) {
    _adminAuthLimiter = createAdminAuthLimiter();
  }
  return _adminAuthLimiter;
};

export default async function adminApiKeyMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  const apiKeyHeader = request.headers['x-api-key'];

  let apiKey: string | undefined;

  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  } else if (apiKeyHeader) {
    apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined;
  }

  if (!apiKey || !apiKey.startsWith('archive_')) {
    return reply.status(401).send({
      error: {
        message: 'Missing or invalid API key',
        code: 'UNAUTHORIZED',
        statusCode: 401,
      },
    });
  }

  const limiter = getAdminAuthLimiter();
  const ip =
    (request.headers['cf-connecting-ip'] as string) ??
    (request.headers['x-real-ip'] as string) ??
    (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    request.ip ??
    'unknown';

  try {
    await limiter.consume(ip);
  } catch {
    return reply.status(429).send({
      error: {
        message: 'Too Many Requests',
        code: 'RATE_LIMITED',
        statusCode: 429,
      },
    });
  }

  const admin = await findAdminByApiKey(apiKey);

  if (!admin) {
    getLogger().warn({ ip, apiKeyPrefix: apiKey.substring(0, 8) }, 'Invalid admin API key used');
    return reply.status(401).send({
      error: {
        message: 'Invalid API key',
        code: 'UNAUTHORIZED',
        statusCode: 401,
      },
    });
  }

  request.admin = {
    adminId: admin.id,
    username: admin.username,
  };
}
