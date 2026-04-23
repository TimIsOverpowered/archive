import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { validateCloudflareRequest } from '../../utils/cloudflare-ip-validator.js';
import { getClientIp } from './ip.js';

type RateLimiter = RateLimiterRedis | RateLimiterMemory;

/** Configuration for the rate limit middleware factory. */
interface RateLimitOptions {
  limiter: RateLimiter;
  writeLimiter?: RateLimiter;
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

    const isValidCfRequest = await validateCloudflareRequest(request);
    if (!isValidCfRequest) {
      return reply.status(403).send({
        error: {
          message: 'Forbidden',
          code: 'FORBIDDEN',
          statusCode: 403,
        },
      });
    }

    const ip = getClientIp(request);

    try {
      const consumeResult = await activeLimiter.consume(ip);

      reply.header('X-RateLimit-Limit', activeLimiter.points);
      reply.header('X-RateLimit-Remaining', String(consumeResult.remainingPoints));
    } catch (rateLimitError) {
      const error = rateLimitError as Error & { msBeforeNext?: number; code?: string };

      if ('msBeforeNext' in error && error.msBeforeNext != null) {
        const retryAfter = Math.ceil(error.msBeforeNext / 1000);

        return reply.status(429).send({
          error: {
            message: 'Too Many Requests',
            code: 'RATE_LIMITED',
            statusCode: 429,
            retryAfter,
          },
        });
      }

      return reply.status(500).send({
        error: {
          message: 'Internal server error',
          code: 'INTERNAL_ERROR',
          statusCode: 500,
        },
      });
    }
  };
}
