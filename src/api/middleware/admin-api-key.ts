import { FastifyRequest, FastifyReply } from 'fastify';
import { findAdminByApiKey } from '../../services/admin.service.js';
import { RedisService } from '../../utils/redis-service.js';
import { getLogger } from '../../utils/logger.js';
import { getClientIp } from './ip.js';
import { createHash } from 'node:crypto';

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

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  } else if (typeof apiKeyHeader === 'string') {
    apiKey = apiKeyHeader;
  }

  if (apiKey == null || !apiKey.startsWith('archive_')) {
    return reply.status(401).send({
      statusCode: 401,
      message: 'Missing or invalid API key',
      code: 'UNAUTHORIZED',
    });
  }

  const limiter = RedisService.getLimiter('rate:admin:auth');
  if (!limiter) {
    return reply.status(503).send({
      statusCode: 503,
      message: 'Service unavailable',
      code: 'SERVICE_UNAVAILABLE',
    });
  }
  const ip = getClientIp(request);

  try {
    await limiter.consume(ip);
  } catch {
    return reply.status(429).send({
      statusCode: 429,
      message: 'Too Many Requests',
      code: 'RATE_LIMITED',
    });
  }

  const admin = await findAdminByApiKey(apiKey);

  if (!admin) {
    const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').substring(0, 12);
    getLogger().warn({ ip, keyFingerprint }, 'Invalid admin API key used');
    return reply.status(401).send({
      statusCode: 401,
      message: 'Invalid API key',
      code: 'UNAUTHORIZED',
    });
  }

  request.admin = {
    adminId: admin.id,
    username: admin.username,
  };
}
