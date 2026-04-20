import { getKickStreamStatus, getLatestKickVodObject } from '../kick-live.js';
import { getVod, finalizeKickChapters } from '../kick.js';
import type {
  PlatformStrategy,
  PlatformStreamStatus,
  PlatformVodMetadata,
  VodCreateData,
  VodUpdateData,
} from './strategy.js';
import { getLogger } from '../../utils/logger.js';
export const kickStrategy: PlatformStrategy = {
  async checkStreamStatus(ctx): Promise<PlatformStreamStatus | null> {
    const { config, platform } = ctx;

    if (!config?.[platform]?.enabled) {
      return null;
    }

    const username = config?.kick?.username;
    if (!username) {
      return null;
    }

    const streamStatus = await getKickStreamStatus(username);

    if (!streamStatus) {
      return null;
    }

    return {
      id: streamStatus.id,
      title: streamStatus.session_title || '',
      startedAt: streamStatus.created_at,
      streamId: streamStatus.id,
      platformUserId: config?.kick?.id ?? undefined,
      platformUsername: username,
    };
  },

  async fetchVodMetadata(vodId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const username = config?.[platform]?.username;
    if (!username) {
      return null;
    }

    const vodData = await getVod(username, vodId);

    return {
      id: `${vodData.id}`,
      title: vodData.session_title || '',
      createdAt: vodData.created_at,
      duration: Math.floor(Number(vodData.duration) / 1000),
      streamId: `${vodData.id}`,
      sourceUrl: vodData.source ?? undefined,
    };
  },

  async fetchVodObjectForLiveStream(streamId: string, ctx): Promise<PlatformVodMetadata | null> {
    const { config, platform } = ctx;

    const username = config?.[platform]?.username;
    if (!username) {
      return null;
    }

    const vodObject = await getLatestKickVodObject(username, streamId);

    if (!vodObject) {
      return null;
    }

    return {
      id: vodObject.id,
      title: vodObject.title || '',
      createdAt: new Date().toISOString(),
      duration: 0,
      streamId,
      sourceUrl: vodObject.source ?? undefined,
    };
  },

  createVodData(meta: PlatformVodMetadata): VodCreateData {
    return {
      vod_id: meta.id,
      title: meta.title || null,
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
      title: meta.title || null,
      created_at: new Date(meta.createdAt),
      duration: meta.duration,
      stream_id: meta.streamId,
    };
  },

  async finalizeChapters(ctx, dbId, vodId, finalDurationSeconds): Promise<void> {
    try {
      await finalizeKickChapters(
        { tenantId: ctx.tenantId, config: ctx.config, db: ctx.db! },
        dbId,
        vodId,
        finalDurationSeconds
      );
    } catch (error) {
      getLogger().error({ vodId, error }, 'Failed to finalize Kick chapters');
    }
  },
};
