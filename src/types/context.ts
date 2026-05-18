import type { Kysely } from 'kysely';
import type { TenantConfig } from '../config/types.js';
import type { StreamerDB } from '../db/streamer-types.js';
import type { Platform } from './platforms.js';

export interface TenantContext {
  tenantId: string;
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  platform?: Platform;
}
