import { getAppAccessToken, VodData } from '../services/twitch.js';
import { extractErrorDetails, throwOnHttpError } from '../utils/error.js';
import { getTwitchCredentials as getCreds } from '../utils/credentials.js';
import { logger } from '../utils/logger.js';

export interface TwitchStreamStatus {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_id?: string | null;
  game_name?: string | null;
  type: string;
  title: string;
  tags?: string[] | null;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url?: string | null;
}

/**
 * Check if a Twitch user is currently live via Helix API
 */
export async function getTwitchStreamStatus(userId: string, tenantId: string): Promise<TwitchStreamStatus | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getCreds(tenantId);

    if (!creds) {
      logger.warn({ tenantId }, `[Twitch Live Check] No credentials configured for tenant ${tenantId}`);
      return null;
    }

    const url = new URL('https://api.twitch.tv/helix/streams');
    url.searchParams.append('user_id', userId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      signal: AbortSignal.timeout(10000),
    });

    throwOnHttpError(response, 'Twitch API');

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      return null;
    }

    const streamData = data.data[0];

    return {
      id: streamData.id,
      user_id: streamData.user_id,
      user_login: streamData.user_login,
      user_name: streamData.user_name || '',
      game_id: streamData.game_id ?? undefined,
      game_name: streamData.game_name ?? undefined,
      type: streamData.type || '',
      title: streamData.title || '',
      tags: streamData.tags ?? undefined,
      viewer_count: streamData.viewer_count,
      started_at: streamData.started_at,
      language: streamData.language || 'other',
      thumbnail_url: streamData.thumbnail_url ?? undefined,
    };
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    logger.error({ userId, err: message }, `[Twitch Live Check] Failed to get stream status for user ${userId}`);
    return null;
  }
}

/**
 * Immediate check for Twitch VOD object matching current stream (NON-BLOCKING)
 * Returns immediately with result or null if not ready yet
 */
export async function getLatestTwitchVodObject(userId: string, expectedStreamId: string, tenantId: string): Promise<VodData | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getCreds(tenantId);

    if (!creds) {
      logger.warn({ tenantId }, `[Twitch] No credentials configured for tenant ${tenantId}`);
      return null;
    }

    const url = new URL('https://api.twitch.tv/helix/videos');
    url.searchParams.append('user_id', userId);
    url.searchParams.append('first', '1');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      signal: AbortSignal.timeout(10000),
    });

    throwOnHttpError(response, 'Twitch API');

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      return null; // No VODs exist yet
    }

    const latestVod = data.data[0];

    if (latestVod.stream_id !== expectedStreamId || !latestVod.id) {
      return null; // Wrong VOD or no ID yet - caller should retry later
    }

    logger.info({ userId, stream_id: latestVod.stream_id, id: latestVod.id }, `[Twitch] VOD object ready! Match found: stream_id=${latestVod.stream_id}, vod_id=${latestVod.id}`);

    return latestVod;
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    logger.error({ userId, err: message }, `[Twitch] Failed to get VOD object for user ${userId}`);
    return null;
  }
}
