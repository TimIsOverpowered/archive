import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { findAdminByApiKey } from '../../services/admin.service.js';
import { RedisService } from '../../utils/redis-service.js';
import { getLogger } from '../../utils/logger.js';
import { getClientIp } from './ip.js';
import { createHash } from 'node:crypto';
import { errorResponse } from '../response.js';

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
    return reply.status(401).send(errorResponse(401, 'Missing or invalid API key', 'UNAUTHORIZED'));
  }

  const limiter = RedisService.requireLimiter('rate:admin:auth');
  const ip = getClientIp(request);

  try {
    await limiter.consume(ip);
  } catch (err) {
    const retryAfter = err instanceof RateLimiterRes ? Math.ceil(err.msBeforeNext / 1000) : 1;
    reply.header('Retry-After', String(retryAfter));
    return reply.status(429).send(
      errorResponse(429, 'Too Many Requests', 'RATE_LIMITED', retryAfter)
    );
  }

  const admin = await findAdminByApiKey(apiKey);

  if (!admin) {
    const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').substring(0, 12);
    getLogger().warn({ ip, keyFingerprint }, 'Invalid admin API key used');
    return reply.status(401).send(errorResponse(401, 'Invalid API key', 'UNAUTHORIZED'));
  }

  request.admin = {
    adminId: admin.id,
    username: admin.username,
  };
}
