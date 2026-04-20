import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types';
import type { TenantConfig } from '../config/types';

export interface TenantContext {
  tenantId: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
}
