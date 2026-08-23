import type { Kysely } from 'kysely';
import type { TenantConfig } from '../config/types.ts';
import type { StreamerDB } from '../db/streamer-types.ts';
import type { Platform } from './platforms.ts';

export interface TenantContext {
  tenantId: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  platform?: Platform;
}
