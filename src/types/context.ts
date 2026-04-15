import type { PrismaClient } from '../../generated/streamer/client';
import type { TenantConfig } from '../config/types';

export interface TenantContext {
  tenantId: string;
  config: TenantConfig;
  db: PrismaClient;
}
