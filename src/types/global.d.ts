/**
 * Global TypeScript type declarations for shared state across modules.
 */
import type Redis from 'ioredis';
import type { AdminContext } from '../api/middleware/admin-api-key.js';
import type { TenantContext } from './context.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }

  interface FastifyRequest {
    admin?: AdminContext;
    tenant: TenantContext;
    tenantDisplayName?: string;
    reqId?: string;
  }
}
