import { requirePlatformConfig } from '../../config/types.js';
import { PLATFORMS } from '../../types/platforms.js';
import { createErrorContext } from '../../utils/error.js';
import { parseTwitchDuration } from '../../utils/formatting.js';
import { getLogger } from '../../utils/logger.js';
import { retryWithBackoff } from '../../utils/retry.js';
import type {
  PlatformStrategy,
  PlatformStreamStatus,
  PlatformVodMetadata,
  VodCreateData,
  VodUpdateData,
} from '../platforms/strategy.js';
import { getChapters, saveVodChapters } from './chapters.js';
import { getTwitchStreamStatus, getLatestTwitchVodObject } from './live.js';
import { getVodData } from './vod.js';

export const strategy: PlatformStrategy = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { tenantId, config, platform } = ctx;
    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const streamStatus = await getTwitchStreamStatus(cfg.platformUserId, { tenantId });

    if (streamStatus == null || streamStatus.type !== 'live') {
      return null;
    }

    return {
      id: streamStatus.id,
      title: streamStatus.title,
      startedAt: streamStatus.started_at,
      streamId: streamStatus.id,
      platformUserId: streamStatus.user_id,
      platformUsername: streamStatus.user_login,
    };
  },

  async fetchVodMetadata(vodId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { tenantId } = ctx;

    const vodData = await getVodData(vodId, { tenantId });

    return {
      id: vodData.id,
      title: vodData.title,
      createdAt: vodData.created_at,
      duration: parseTwitchDuration(vodData.duration),
      streamId: vodData.stream_id ?? null,
    };
  },

  async fetchVodObjectForLiveStream(streamId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { tenantId, config, platform } = ctx;
    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const vodObject = await getLatestTwitchVodObject(cfg.platformUserId, streamId, { tenantId });

    if (vodObject == null || vodObject.stream_id !== streamId) {
      return null;
    }

    return {
      id: vodObject.id,
      title: vodObject.title,
      createdAt: vodObject.created_at,
      duration: parseTwitchDuration(vodObject.duration),
      streamId: vodObject.stream_id ?? null,
    };
  },

  createVodData(meta: PlatformVodMetadata): VodCreateData {
    return {
      platform_vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: meta.createdAt,
      duration: meta.duration,
      platform_stream_id: meta.streamId ?? null,
      platform: PLATFORMS.TWITCH,
      is_live: false,
    };
  },

  updateVodData(meta: PlatformVodMetadata): VodUpdateData {
    return {
      platform_vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      platform_stream_id: meta.streamId,
    };
  },

  async finalizeChapters(ctx, dbId, vodId, finalDurationSeconds): Promise<void> {
    try {
      await retryWithBackoff(
        async () => {
          const chapters = await getChapters(vodId, ctx.tenantId);
          await saveVodChapters({
            ctx: { tenantId: ctx.tenantId, config: ctx.config },
            dbId,
            vodId,
            finalDurationSeconds,
            chapters,
          });
        },
        { attempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
      );
    } catch (error) {
      getLogger().error(createErrorContext(error, { vodId }), 'Failed to finalize Twitch chapters');
    }
  },
};
