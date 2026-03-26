"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = createRateLimitMiddleware;
function createRateLimitMiddleware(options) {
    return async (request, reply) => {
        const { limiter, writeLimiter } = options;
        const method = request.method;
        const activeLimiter = method === 'GET' ? limiter : writeLimiter || limiter;
        try {
            const ip = request.ip;
            await activeLimiter.consume(ip);
            reply.header('X-RateLimit-Limit', activeLimiter.points);
            reply.header('X-RateLimit-Remaining', activeLimiter.points);
        }
        catch (rateLimitError) {
            const retryAfter = Math.ceil(rateLimitError.msBeforeNext / 1000);
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
//# sourceMappingURL=rate-limit.js.map