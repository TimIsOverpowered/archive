import { getAppAccessToken } from './auth.js';
import type { VodData } from './vod.js';
import { extractErrorDetails } from '../../utils/error.js';
import { getTwitchCredentials } from '../../utils/credentials.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { request } from '../../utils/http-client.js';
import { Twitch } from '../../constants.js';

const log = createAutoLogger('twitch-live');

export interface TwitchStreamStatus {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id?: string | null | undefined;
  game_name?: string | null | undefined;
  type: string;
  title: string;
  tags?: (string[] | null) | undefined;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url?: string | null | undefined;
}

export async function getTwitchStreamStatus(userId: string, tenantId: string): Promise<TwitchStreamStatus | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getTwitchCredentials(tenantId);

    if (!creds) {
      log.warn({ component: 'twitch-live', tenantId }, 'No credentials configured for tenant');
      return null;
    }

    const url = new URL(`${Twitch.HELIX_BASE_URL}/streams`);
    url.searchParams.append('user_id', userId);

    const data = await request<{ data: TwitchStreamStatus[] | null }>(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      logContext: { userId, tenantId },
    });

    if (!data.data || data.data.length === 0) {
      return null;
    }

    const streamData = data.data[0];
    if (!streamData) return null;

    return {
      id: streamData.id,
      user_id: streamData.user_id,
      user_login: streamData.user_login,
      user_name: streamData.user_name ?? '',
      game_id: streamData.game_id ?? undefined,
      game_name: streamData.game_name ?? undefined,
      type: streamData.type ?? '',
      title: streamData.title ?? '',
      tags: streamData.tags ?? undefined,
      viewer_count: streamData.viewer_count,
      started_at: streamData.started_at,
      language: streamData.language ?? 'other',
      thumbnail_url: streamData.thumbnail_url ?? undefined,
    };
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    log.error({ component: 'twitch-live', userId, err: message }, 'Failed to get stream status for user');
    throw error;
  }
}

export async function getLatestTwitchVodObject(
  userId: string,
  expectedStreamId: string,
  tenantId: string
): Promise<VodData | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getTwitchCredentials(tenantId);

    if (!creds) {
      log.warn({ component: 'twitch-live', tenantId }, 'No credentials configured for tenant');
      return null;
    }

    const url = new URL('https://api.twitch.tv/helix/videos');
    url.searchParams.append('user_id', userId);
    url.searchParams.append('first', '1');

    const data = await request<{ data: VodData[] | null }>(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      logContext: { userId, tenantId },
    });

    if (!data.data || data.data.length === 0) {
      return null;
    }

    const latestVod = data.data[0];
    if (!latestVod) return null;

    if (latestVod.stream_id !== expectedStreamId || latestVod.id == null) {
      return null;
    }

    log.info(
      { component: 'twitch-live', userId, stream_id: latestVod.stream_id, id: latestVod.id },
      'VOD object ready! Match found'
    );

    return latestVod;
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    log.error({ component: 'twitch-live', userId, err: message }, 'Failed to get VOD object for user');
    throw error;
  }
}
