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
        statusCode: 403,
        message: 'Forbidden',
        code: 'FORBIDDEN',
      });
    }

    const ip = getClientIp(request);

    try {
      const consumeResult = await activeLimiter.consume(ip);

      reply.header('X-RateLimit-Limit', activeLimiter.points);
      reply.header('X-RateLimit-Remaining', String(consumeResult.remainingPoints));
    } catch (rateLimitError) {
      if (
        typeof rateLimitError === 'object' &&
        rateLimitError !== null &&
        'msBeforeNext' in rateLimitError &&
        typeof (rateLimitError as { msBeforeNext: unknown }).msBeforeNext === 'number'
      ) {
        const retryAfter = Math.ceil((rateLimitError as { msBeforeNext: number }).msBeforeNext / 1000);

        return reply.status(429).send({
          statusCode: 429,
          message: 'Too Many Requests',
          code: 'RATE_LIMITED',
          retryAfter,
        });
      }

      return reply.status(500).send({
        statusCode: 500,
        message: 'Internal server error',
        code: 'INTERNAL_ERROR',
      });
    }
  };
}
