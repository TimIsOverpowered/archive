/**
 * Global TypeScript type declarations for shared state across modules.
 */
import type Redis from 'ioredis';
import type { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import type { AdminContext } from '../api/middleware/admin-api-key.js';
import type { TenantContext } from './context.js';

type RateLimiter = RateLimiterRedis | RateLimiterMemory;

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    publicRateLimiter: RateLimiter;
    chatRateLimiter: RateLimiter;
    adminRateLimiter: RateLimiter;
  }

  interface FastifyRequest {
    admin?: AdminContext;
    tenant?: TenantContext;
    tenantDisplayName?: string;
    reqId?: string;
  }
}
