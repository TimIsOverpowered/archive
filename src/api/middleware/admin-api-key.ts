import { FastifyRequest, FastifyReply } from 'fastify';
import { findAdminByApiKey } from '../../services/admin.service.js';
import { RedisService } from '../../utils/redis-service.js';
import { getLogger } from '../../utils/logger.js';
import { getClientIp } from './ip.js';

/** Admin identity attached to the request after successful API key authentication. */
export interface AdminContext {
  adminId: number;
  username: string;
}

/**
 * Admin API key authentication middleware.
 * Accepts `Authorization: Bearer archive_...` or `X-API-Key: archive_...` headers.
 * Enforces per-IP auth rate limit (20 attempts/sec) and attaches admin identity to request.
 */
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

  const limiter = RedisService.getLimiter('rate:admin:auth');
  if (!limiter) {
    return reply.status(503).send({
      error: {
        message: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
      },
    });
  }
  const ip = getClientIp(request);

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
