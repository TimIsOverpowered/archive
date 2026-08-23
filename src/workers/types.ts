import type { Kysely } from 'kysely';
import type { TenantConfig } from '../config/types.ts';
import type { StreamerDB } from '../db/streamer-types.ts';
import type { Platform } from '../types/platforms.ts';
import type { AppLogger } from '../utils/logger.ts';

export interface BaseWorkerContext {
  config: TenantConfig;
  db: Kysely<StreamerDB>;
  tenantId: string;
  log: AppLogger;
  messageId: string | null;
  dbId: number;
  vodId: string;
  platform: Platform;
}

export interface LiveCompletionData {
  emotesSaved: boolean;
  chatJobId: string | null;
  youtubeVodJobId: string | null;
  youtubeGameJobIds: string[];
  segmentCount: number;
  finalPath: string;
  streamerName?: string;
  platform?: Platform;
}
