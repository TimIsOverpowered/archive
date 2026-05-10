import { Twitch } from '../../constants.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { getTwitchAppCredentials } from '../../utils/credentials.js';
import { extractErrorDetails } from '../../utils/error.js';
import { request } from '../../utils/http-client.js';
import { getAppAccessToken } from './auth.js';
import type { VodData } from './vod.js';

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

export async function getTwitchStreamStatus(
  userId: string,
  logContext?: Record<string, unknown>
): Promise<TwitchStreamStatus | null> {
  try {
    const accessToken = await getAppAccessToken();
    const { clientId } = getTwitchAppCredentials();

    const url = new URL(`${Twitch.HELIX_BASE_URL}/streams`);
    url.searchParams.append('user_id', userId);

    const data = await request<{ data: TwitchStreamStatus[] | null }>(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
      logContext,
    });

    if (!data.data || data.data.length === 0) {
      return null;
    }

    return data.data[0] ?? null;
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    log.error({ component: 'twitch-live', userId, err: message }, 'Failed to get stream status for user');
    throw error;
  }
}

/**
 * Batch fetch stream status for multiple users. Automatically chunks
 * at Twitch.STREAMS_BATCH_SIZE to stay within API limits.
 * Returns a map of userId -> TwitchStreamStatus | null.
 * Users not in the response are considered offline (null).
 */
export async function getTwitchStreamStatusBatch(
  userIds: string[],
  logContext?: Record<string, unknown>
): Promise<Map<string, TwitchStreamStatus | null>> {
  const result = new Map<string, TwitchStreamStatus | null>();

  if (userIds.length === 0) {
    return result;
  }

  const accessToken = await getAppAccessToken();
  const { clientId } = getTwitchAppCredentials();

  for (let i = 0; i < userIds.length; i += Twitch.STREAMS_BATCH_SIZE) {
    const chunk = userIds.slice(i, i + Twitch.STREAMS_BATCH_SIZE);

    try {
      const url = new URL(`${Twitch.HELIX_BASE_URL}/streams`);
      for (const userId of chunk) {
        url.searchParams.append('user_id', userId);
      }

      const data = await request<{ data: TwitchStreamStatus[] | null }>(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': clientId,
        },
        logContext,
      });

      if (data?.data) {
        for (const streamData of data.data) {
          result.set(streamData.user_id, streamData);
        }
      }
    } catch (error: unknown) {
      const { message } = extractErrorDetails(error);
      log.error({ component: 'twitch-live', userIds: chunk, err: message }, 'Failed to batch get stream status');
      throw error;
    }
  }

  return result;
}

export async function getLatestTwitchVodObject(
  userId: string,
  expectedStreamId: string,
  logContext?: Record<string, unknown>
): Promise<VodData | null> {
  try {
    const accessToken = await getAppAccessToken();
    const { clientId } = getTwitchAppCredentials();

    const url = new URL('https://api.twitch.tv/helix/videos');
    url.searchParams.append('user_id', userId);
    url.searchParams.append('first', '1');

    const data = await request<{ data: VodData[] | null }>(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
      logContext,
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
