import { RedisClientType } from 'redis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import type { FastifyPluginAsync } from 'fastify';
interface RedisPluginOptions {
    url: string;
}
export declare let redisClient: RedisClientType | null;
export declare let publicRateLimiter: RateLimiterRedis | null;
export declare let chatRateLimiter: RateLimiterRedis | null;
export declare let adminRateLimiter: RateLimiterRedis | null;
declare const redisPlugin: FastifyPluginAsync<RedisPluginOptions>;
export default redisPlugin;
//# sourceMappingURL=redis.plugin.d.ts.map