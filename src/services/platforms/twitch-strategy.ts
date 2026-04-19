import { getTwitchStreamStatus, getLatestTwitchVodObject } from '../twitch/live.js';
import { getVodData } from '../twitch/vod.js';
import { saveVodChapters } from '../twitch/chapters.js';
import type { PlatformStrategy, PlatformStreamStatus, PlatformVodMetadata } from './strategy.js';
import { parseTwitchDuration } from '../../utils/formatting.js';
import { createErrorContext } from '../../utils/error.js';
import { getLogger } from '../../utils/logger.js';

export const twitchStrategy: PlatformStrategy = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { tenantId, config, platform } = ctx;
    if (!config?.[platform]?.enabled) {
      return null;
    }

    const userId = config?.[platform]?.id;
    if (!userId) {
      return null;
    }

    const streamStatus = await getTwitchStreamStatus(userId, tenantId);

    if (!streamStatus || streamStatus.type !== 'live') {
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
    const userId = config?.[platform]?.id;
    if (!userId) {
      return null;
    }

    const vodObject = await getLatestTwitchVodObject(userId, streamId, tenantId);

    if (!vodObject || vodObject.stream_id !== streamId) {
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

  createVodData(meta: PlatformVodMetadata): import('../../../generated/streamer/client.js').Prisma.VodCreateInput {
    return {
      vod_id: meta.id,
      title: meta.title || null,
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId,
      platform: 'twitch',
      is_live: false,
    };
  },

  updateVodData(meta: PlatformVodMetadata): import('../../../generated/streamer/client.js').Prisma.VodUpdateInput {
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
      await saveVodChapters(
        { tenantId: ctx.tenantId, config: ctx.config, db: ctx.db! },
        dbId,
        vodId,
        finalDurationSeconds
      );
    } catch (error) {
      getLogger().error(createErrorContext(error, { vodId }), 'Failed to finalize Twitch chapters');
    }
  },
};
