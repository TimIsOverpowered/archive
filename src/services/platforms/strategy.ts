import type { Platform } from '../../types/platforms.js';
import type { Kysely } from 'kysely';
import type { TenantConfig } from '../../config/types.js';
import type { StreamerDB } from '../../db/streamer-types.js';

/** Data shape for creating a VOD record from platform metadata. */
export interface VodCreateData {
  vod_id: string;
  platform: string;
  title: string | null;
  created_at: Date;
  duration: number;
  stream_id: string | null;
  is_live: boolean;
}

/** Data shape for updating a VOD record. */
export interface VodUpdateData {
  vod_id?: string;
  title?: string | null;
  created_at?: Date;
  duration?: number;
  stream_id?: string | null | undefined;
}

/** Current live stream status from a platform. */
export interface PlatformStreamStatus {
  id: string;
  title: string;
  startedAt: string;
  streamId?: string | null | undefined;
  platformUserId?: string | null | undefined;
  platformUsername?: string | null | undefined;
}

/** VOD metadata fetched from a platform API. */
export interface PlatformVodMetadata {
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  streamId?: string | null | undefined;
  sourceUrl?: string | null | undefined;
}

/** Context passed to platform strategy methods. */
export interface PlatformStrategyContext {
  tenantId: string;
  config: TenantConfig;
  platform: Platform;
  db?: Kysely<StreamerDB>;
}

/**
 * Contract for platform-specific VOD operations.
 * Each platform (Twitch, Kick, YouTube) implements this interface.
 */
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

/** Register a platform strategy for a given platform identifier. */
export function registerStrategy(platform: Platform, strategy: PlatformStrategy): void {
  strategies.set(platform, strategy);
}

/** Retrieve the strategy registered for a platform, or undefined if not found. */
export function getStrategy(platform: Platform): PlatformStrategy | undefined {
  return strategies.get(platform);
}
