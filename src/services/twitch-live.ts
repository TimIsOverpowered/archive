import axios from 'axios';
import { getAppAccessToken } from '../services/twitch.js';
import { getTwitchCredentials as getCreds } from '../utils/credentials.js';
import { logger } from '../utils/logger.js';

export interface TwitchStreamStatus {
  id: string;
  user_id: string;
  user_login: string;
  game_id?: string;
  type: string[];
  title: string;
  started_at: string;
  viewer_count: number;
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

    const response = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_id: userId },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      timeout: 10000,
    });

    if (!response.data.data || response.data.data.length === 0) {
      return null;
    }

    const streamData = response.data.data[0];

    // Normalize type field to array (Twitch API returns "live" string for live streams)
    const normalizedType: string[] = Array.isArray(streamData.type) ? streamData.type : [streamData.type || ''];

    return {
      id: streamData.id,
      user_id: streamData.user_id,
      user_login: streamData.user_login,
      game_id: streamData.game_id,
      type: normalizedType.includes('live') ? ['live'] : [],
      title: streamData.title || '',
      started_at: streamData.started_at,
      viewer_count: streamData.viewer_count,
    };
  } catch (error: any) {
    logger.error({ userId }, `[Twitch Live Check] Failed to get stream status for user ${userId}:`, error.message);
    return null;
  }
}

/**
 * Immediate check for Twitch VOD object matching current stream (NON-BLOCKING)


/**
 * Immediate check for Twitch VOD object matching current stream (NON-BLOCKING)
 * Returns immediately with result or null if not ready yet - matches legacy behavior
 */
export async function getLatestTwitchVodObject(userId: string, expectedStreamId: string, tenantId: string): Promise<{ vodId: string; stream_id: string } | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getCreds(tenantId);

    if (!creds) {
      logger.warn({ tenantId }, `[Twitch] No credentials configured for tenant ${tenantId}`);
      return null;
    }

    const response = await axios.get('https://api.twitch.tv/helix/videos', {
      params: { user_id: userId, first: 1 },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      timeout: 10000,
    });

    if (!response.data.data || response.data.data.length === 0) {
      return null; // No VODs exist yet
    }

    const latestVod = response.data.data[0];

    // CRITICAL CHECK - legacy pattern: fail immediately if stream_id doesn't match
    if (latestVod.stream_id !== expectedStreamId || !latestVod.id) {
      return null; // Wrong VOD or no ID yet - caller should retry later
    }

    logger.info({ userId, stream_id: latestVod.stream_id, vodId: latestVod.id }, `[Twitch] VOD object ready! Match found: stream_id=${latestVod.stream_id}, vod_id=${latestVod.id}`);

    return {
      vodId: latestVod.id,
      stream_id: latestVod.stream_id,
    };
  } catch (error: any) {
    logger.error({ userId }, `[Twitch] Failed to get VOD object for user ${userId}:`, error.message);
    return null;
  }
}

/**
 * Get full Twitch VOD details by ID
 */
export async function getTwitchVodDetails(vodId: string, tenantId: string): Promise<any | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);
    const creds = getCreds(tenantId);

    if (!creds) {
      logger.error({ tenantId }, `[Twitch] No credentials configured for tenant ${tenantId}`);
      return null;
    }

    const response = await axios.get('https://api.twitch.tv/helix/videos', {
      params: { id: vodId },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      timeout: 10000,
    });

    if (!response.data.data || response.data.data.length === 0) {
      return null;
    }

    return response.data.data[0];
  } catch (error: any) {
    logger.error({ vodId }, `[Twitch] Failed to get VOD details for ${vodId}:`, error.message);
    return null;
  }
}
