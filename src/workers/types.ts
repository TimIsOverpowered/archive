import type { TenantConfig } from '../config/types.js';
import type { Kysely } from 'kysely';
import type { StreamerDB } from '../db/streamer-types.js';
import type { AppLogger } from '../utils/logger.js';
import type { Platform } from '../types/platforms.js';

export interface BaseWorkerContext {
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  log: AppLogger;
  messageId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
}
