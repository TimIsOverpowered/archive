import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';

interface RateLimitOptions {
  limiter: RateLimiterRedis;
  writeLimiter?: RateLimiterRedis;
}

export default function createRateLimitMiddleware(options: RateLimitOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { limiter, writeLimiter } = options;
    const method = request.method;
    const activeLimiter = method === 'GET' ? limiter : writeLimiter || limiter;

    try {
      const ip = request.ip;
      await activeLimiter.consume(ip);

      reply.header('X-RateLimit-Limit', activeLimiter.points);
      reply.header('X-RateLimit-Remaining', activeLimiter.points);
    } catch (rateLimitError) {
      const error = rateLimitError as { msBeforeNext?: number };
      const retryAfter = error.msBeforeNext ? Math.ceil(error.msBeforeNext / 1000) : 60;

      return reply.status(429).send({
        error: {
          message: 'Too Many Requests',
          code: 'RATE_LIMITED',
          statusCode: 429,
          retryAfter,
        },
      });
    }
  };
}
