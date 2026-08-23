import { requirePlatformConfig } from '../../config/types.ts';
import { PLATFORMS } from '../../types/platforms.ts';
import { toUtcDate, toUtcISO } from '../../utils/datetime.ts';
import { createErrorContext } from '../../utils/error.ts';
import { getLogger } from '../../utils/logger.ts';
import { retryWithBackoff } from '../../utils/retry.ts';
import type {
  PlatformStrategy,
  PlatformStreamStatus,
  PlatformVodMetadata,
  VodCreateData,
  VodUpdateData,
} from '../platforms/strategy.ts';
import { finalizeKickChapters, getKickStreamStatus, getLatestKickVodObject, getVod } from './index.ts';
export const strategy: PlatformStrategy<VodCreateData, VodUpdateData> = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const streamStatus = await getKickStreamStatus(cfg.platformUsername, `kick-${cfg.platformUserId}`);

    if (streamStatus == null) {
      return null;
    }

    return {
      id: String(streamStatus.id),
      title: streamStatus.session_title ?? '',
      startedAt: toUtcISO(streamStatus.created_at),
      streamId: String(streamStatus.id),
      platformUserId: cfg.platformUserId,
      platformUsername: cfg.platformUsername,
    };
  },

  async fetchVodMetadata(vodId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const vodData = await getVod(cfg.platformUsername, vodId, `kick-${cfg.platformUserId}`);

    return {
      id: `${vodData.id}`,
      title: vodData.session_title ?? '',
      createdAt: toUtcISO(vodData.created_at),
      duration: Math.floor(Number(vodData.duration) / 1000),
      streamId: `${vodData.id}`,
      sourceUrl: vodData.source ?? undefined,
    };
  },

  async fetchVodObjectForLiveStream(streamId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const vodObject = await getLatestKickVodObject(
      cfg.platformUsername,
      streamId,
      cfg.platformUserId,
      `kick-${cfg.platformUserId}`
    );

    if (!vodObject) {
      return null;
    }

    return {
      id: String(vodObject.id),
      title: vodObject.session_title ?? '',
      createdAt: toUtcISO(vodObject.created_at),
      duration: 0,
      streamId,
      sourceUrl: vodObject.source ?? undefined,
    };
  },

  createVodData(meta: PlatformVodMetadata): VodCreateData {
    return {
      platform_vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: toUtcISO(meta.createdAt),
      duration: meta.duration,
      platform_stream_id: meta.streamId ?? null,
      platform: PLATFORMS.KICK,
      is_live: false,
    };
  },

  updateVodData(meta: PlatformVodMetadata): VodUpdateData {
    return {
      platform_vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: toUtcDate(meta.createdAt),
      duration: meta.duration,
      platform_stream_id: meta.streamId,
    };
  },

  async finalizeChapters(ctx, dbId, vodId, finalDurationSeconds): Promise<void> {
    try {
      await retryWithBackoff(
        async () => {
          await finalizeKickChapters({ tenantId: ctx.tenantId, config: ctx.config }, dbId, vodId, finalDurationSeconds);
        },
        { attempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 }
      );
    } catch (error) {
      getLogger().error(createErrorContext(error, { vodId }), 'Failed to finalize Kick chapters');
    }
  },
};
