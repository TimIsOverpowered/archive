/**
 * Global TypeScript type declarations for shared state across modules.
 */
import type Redis from 'ioredis';
import type { TenantConfig } from '../config/types.js';
import type { AdminContext } from '../api/middleware/admin-api-key.js';
import type { TenantContext } from '../api/middleware/tenant-platform.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    getTenantConfig(id: string): TenantConfig | undefined;
    getAllConfigs(): Promise<TenantConfig[]>;
    clearConfigCache(tenantId?: string): void;
    reloadTenantConfig(id: string): Promise<TenantConfig | undefined>;
  }

  interface FastifyRequest {
    admin?: AdminContext;
    tenant: TenantContext;
    tenantDisplayName?: string;
    reqId?: string;
  }
}
