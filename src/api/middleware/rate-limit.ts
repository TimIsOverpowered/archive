import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { validateCloudflareRequest } from '../../utils/cloudflare-ip-validator.js';

interface RateLimitOptions {
  limiter: RateLimiterRedis;
  writeLimiter?: RateLimiterRedis;
}

function getClientIp(request: FastifyRequest): string {
  return (
    (request.headers['cf-connecting-ip'] as string) ??
    (request.headers['x-real-ip'] as string) ??
    (request.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ??
    request.ip ??
    'unknown'
  );
}

export default function createRateLimitMiddleware(options: RateLimitOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { limiter, writeLimiter } = options;
    const method = request.method;
    const activeLimiter = method === 'GET' ? limiter : writeLimiter || limiter;

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
      await activeLimiter.consume(ip);

      reply.header('X-RateLimit-Limit', activeLimiter.points);
      reply.header('X-RateLimit-Remaining', activeLimiter.points);
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
