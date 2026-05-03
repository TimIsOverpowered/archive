import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { validateCloudflareRequest } from '../../utils/cloudflare-ip-validator.js';
import { getClientIp } from './ip.js';
import { RedisService } from '../../utils/redis-service.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { errorResponse } from '../response.js';

type RateLimiter = RateLimiterRedis | RateLimiterMemory;

/** Configuration for the rate limit middleware factory. */
interface RateLimitOptions {
  limiter: RateLimiter | null;
  writeLimiter?: RateLimiter | null;
}

/**
 * Create a rate limit middleware function.
 * Validates Cloudflare requests, extracts client IP, and enforces rate limits with appropriate headers.
 */
export default function createRateLimitMiddleware(options: RateLimitOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { limiter: readLimiter, writeLimiter } = options;
    const method = request.method;
    const activeLimiter = method === 'GET' ? readLimiter : (writeLimiter ?? readLimiter);

    if (!activeLimiter) {
      getLogger().error({ method }, 'Rate limiter not initialized');
      return reply.status(503).send(errorResponse(503, 'Rate limiter unavailable', 'SERVICE_UNAVAILABLE'));
    }

    const isValidCfRequest = await validateCloudflareRequest(request);
    if (!isValidCfRequest) {
      return reply.status(403).send(errorResponse(403, 'Forbidden', 'FORBIDDEN'));
    }

    const ip = getClientIp(request);

    try {
      const consumeResult = await activeLimiter.consume(ip);

      reply.header('X-RateLimit-Limit', activeLimiter.points);
      reply.header('X-RateLimit-Remaining', String(consumeResult.remainingPoints));
    } catch (rateLimitError) {
      if (rateLimitError instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(rateLimitError.msBeforeNext / 1000);

        reply.header('Retry-After', String(retryAfter));

        return reply.status(429).send(errorResponse(429, 'Too Many Requests', 'RATE_LIMITED', retryAfter));
      }

      const details = extractErrorDetails(rateLimitError);
      getLogger().error({ error: details.message, ip }, 'Rate limiter consume failed');
      return reply.status(500).send(errorResponse(500, 'Internal server error', 'INTERNAL_SERVER_ERROR'));
    }
  };
}

/**
 * Create a rate limit middleware for admin routes.
 * Uses the 'rate:admin' Redis limiter.
 */
export function createAdminRateLimitMiddleware() {
  const limiter = RedisService.requireLimiter('rate:admin');
  return createRateLimitMiddleware({ limiter });
}

/**
 * Create a rate limit middleware for public routes.
 * Uses the 'rate:vods' Redis limiter.
 */
export function createPublicRateLimitMiddleware() {
  const limiter = RedisService.requireLimiter('rate:vods');
  return createRateLimitMiddleware({ limiter });
}
