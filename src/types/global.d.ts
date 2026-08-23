/**
 * Global TypeScript type declarations for shared state across modules.
 */
import type { Redis } from 'ioredis';
import type { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { AdminContext } from '../api/middleware/admin-api-key.ts';
import type { TenantContext } from './context.ts';

type RateLimiter = RateLimiterRedis | RateLimiterMemory;

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    publicRateLimiter: RateLimiter | null;
    chatRateLimiter: RateLimiter | null;
    adminRateLimiter: RateLimiter | null;
  }

  interface FastifyRequest {
    admin?: AdminContext;
    tenant?: TenantContext;
    tenantDisplayName?: string;
    reqId?: string;
  }
}
