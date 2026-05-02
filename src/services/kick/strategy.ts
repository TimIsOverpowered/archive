import { getKickStreamStatus, getLatestKickVodObject, getVod, finalizeKickChapters } from './index.js';
import type {
  PlatformStrategy,
  PlatformStreamStatus,
  PlatformVodMetadata,
  VodCreateData,
  VodUpdateData,
} from '../platforms/strategy.js';
import { getLogger } from '../../utils/logger.js';
import { requirePlatformConfig } from '../../config/types.js';
export const strategy: PlatformStrategy = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const streamStatus = await getKickStreamStatus(cfg.platformUsername);

    if (streamStatus == null) {
      return null;
    }

    return {
      id: streamStatus.id,
      title: streamStatus.session_title ?? '',
      startedAt: streamStatus.created_at,
      streamId: streamStatus.id,
      platformUserId: cfg.platformUserId,
      platformUsername: cfg.platformUsername,
    };
  },

  async fetchVodMetadata(vodId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const vodData = await getVod(cfg.platformUsername, vodId);

    return {
      id: `${vodData.id}`,
      title: vodData.session_title ?? '',
      createdAt: vodData.created_at,
      duration: Math.floor(Number(vodData.duration) / 1000),
      streamId: `${vodData.id}`,
      sourceUrl: vodData.source ?? undefined,
    };
  },

  async fetchVodObjectForLiveStream(streamId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const cfg = requirePlatformConfig(config, platform);
    if (!cfg) return null;

    const vodObject = await getLatestKickVodObject(cfg.platformUsername, streamId);

    if (!vodObject) {
      return null;
    }

    return {
      id: vodObject.id,
      title: vodObject.title ?? '',
      createdAt: new Date().toISOString(),
      duration: 0,
      streamId,
      sourceUrl: vodObject.source ?? undefined,
    };
  },

  createVodData(meta: PlatformVodMetadata): VodCreateData {
    return {
      vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId ?? null,
      platform: 'kick',
      is_live: false,
    };
  },

  updateVodData(meta: PlatformVodMetadata): VodUpdateData {
    return {
      vod_id: meta.id,
      title: meta.title === '' ? null : (meta.title ?? ''),
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId,
    };
  },

  async finalizeChapters(ctx, dbId, vodId, finalDurationSeconds): Promise<void> {
    try {
      await finalizeKickChapters({ tenantId: ctx.tenantId, config: ctx.config }, dbId, vodId, finalDurationSeconds);
    } catch (error) {
      getLogger().error({ vodId, error }, 'Failed to finalize Kick chapters');
    }
  },
};
