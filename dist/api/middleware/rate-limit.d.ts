import { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
interface RateLimitOptions {
    limiter: RateLimiterRedis;
    writeLimiter?: RateLimiterRedis;
}
export default function createRateLimitMiddleware(options: RateLimitOptions): (request: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
export {};
//# sourceMappingURL=rate-limit.d.ts.map