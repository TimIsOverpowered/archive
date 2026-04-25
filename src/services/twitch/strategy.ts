import { getTwitchStreamStatus, getLatestTwitchVodObject } from './live.js';
import { getVodData } from './vod.js';
import { saveVodChapters } from './chapters.js';
import type {
  PlatformStrategy,
  PlatformStreamStatus,
  PlatformVodMetadata,
  VodCreateData,
  VodUpdateData,
} from '../platforms/strategy.js';
import { parseTwitchDuration } from '../../utils/formatting.js';
import { createErrorContext } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';
import { getPlatformConfig } from '../../config/types.js';

export const strategy: PlatformStrategy = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { tenantId, config, platform } = ctx;
    const platformCfg = getPlatformConfig(config, platform);

    if (platformCfg?.enabled !== true) {
      return null;
    }

    const userId = platformCfg?.id;
    if (userId == null) {
      return null;
    }

    const streamStatus = await getTwitchStreamStatus(userId, tenantId);

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

    const vodData = await getVodData(vodId, tenantId);

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
    const platformCfg = getPlatformConfig(config, platform);
    const userId = platformCfg?.id;
    if (userId == null) {
      return null;
    }

    const vodObject = await getLatestTwitchVodObject(userId, streamId, tenantId);

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
      vod_id: meta.id,
      title: meta.title || null,
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId ?? null,
      platform: 'twitch',
      is_live: false,
    };
  },

  updateVodData(meta: PlatformVodMetadata): VodUpdateData {
    return {
      vod_id: meta.id,
      title: meta.title || null,
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId,
    };
  },

  async finalizeChapters(ctx, dbId, vodId, finalDurationSeconds): Promise<void> {
    try {
      await saveVodChapters({ tenantId: ctx.tenantId, config: ctx.config }, dbId, vodId, finalDurationSeconds);
    } catch (error) {
      getLogger().error(createErrorContext(error, { vodId }), 'Failed to finalize Twitch chapters');
    }
  },
};
