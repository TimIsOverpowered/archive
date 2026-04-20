import type { Platform } from '../../types/platforms.js';
import type { Kysely } from 'kysely';
import type { TenantConfig } from '../../config/types.js';
import type { StreamerDB } from '../../db/streamer-types.js';

export interface VodCreateData {
  vod_id: string;
  platform: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null | undefined;
  is_live?: boolean;
}

export interface VodUpdateData {
  vod_id?: string;
  title?: string | null;
  created_at?: Date;
  duration?: number;
  stream_id?: string | null | undefined;
}

export interface PlatformStreamStatus {
  id: string;
  title: string;
  startedAt: string;
  streamId?: string | null;
  platformUserId?: string | null;
  platformUsername?: string | null;
}

export interface PlatformVodMetadata {
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  streamId?: string | null;
  sourceUrl?: string | null;
}

export interface PlatformStrategyContext {
  tenantId: string;
  config: TenantConfig;
  platform: Platform;
  db?: Kysely<StreamerDB>;
}

export interface PlatformStrategy {
  checkStreamStatus(ctx: PlatformStrategyContext): Promise<PlatformStreamStatus | null>;
  fetchVodMetadata(vodId: string, ctx: PlatformStrategyContext): Promise<PlatformVodMetadata | null>;
  createVodData(meta: PlatformVodMetadata): VodCreateData;
  updateVodData(meta: PlatformVodMetadata): VodUpdateData;
  finalizeChapters?(
    ctx: PlatformStrategyContext,
    dbId: number,
    vodId: string,
    finalDurationSeconds: number
  ): Promise<void>;
  fetchVodObjectForLiveStream?(streamId: string, ctx: PlatformStrategyContext): Promise<PlatformVodMetadata | null>;
}

const strategies = new Map<Platform, PlatformStrategy>();

export function registerStrategy(platform: Platform, strategy: PlatformStrategy): void {
  strategies.set(platform, strategy);
}

export function getStrategy(platform: Platform): PlatformStrategy | undefined {
  return strategies.get(platform);
}
