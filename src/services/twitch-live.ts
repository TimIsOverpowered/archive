import axios from 'axios';
import { getAppAccessToken } from '../services/twitch.js';

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

    const response = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_id: userId },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID || '',
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
    console.error(`[Twitch Live Check] Failed to get stream status for user ${userId}:`, error.message);
    return null;
  }
}

/**
 * Wait for Twitch VOD object to appear after live detection
 * Polls /helix/videos until a matching VOD with correct stream_id is found
 */
export async function waitForTwitchVodObject(userId: string, expectedStreamId: string, tenantId: string): Promise<{ vodId: string; data?: any } | null> {
  const maxAttempts = 30; // ~5 minutes (10s * 30)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between attempts

    try {
      const accessToken = await getAppAccessToken(tenantId);

      const response = await axios.get('https://api.twitch.tv/helix/videos', {
        params: { user_id: userId, first: 1 },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': process.env.TWITCH_CLIENT_ID || '',
        },
        timeout: 10000,
      });

      if (!response.data.data || response.data.data.length === 0) {
        continue;
      }

      const latestVod = response.data.data[0];

      // CRITICAL CHECK: VOD is ready when stream_id matches active stream
      if (latestVod.stream_id === expectedStreamId && latestVod.id) {
        console.info(`[Twitch] VOD object created! Match found: stream_id=${latestVod.stream_id}, vod_id=${latestVod.id}`);

        return {
          vodId: latestVod.id,
          data: latestVod,
        };
      }
    } catch (error: any) {
      console.warn(`[Twitch] Attempt ${attempt + 1}/${maxAttempts} failed while waiting for VOD object:`, error.message);
    }
  }

  console.error(`[Twitch] Timeout waiting for VOD object after ${maxAttempts} attempts (~5 minutes)`);
  return null;
}

/**
 * Get full Twitch VOD details by ID
 */
export async function getTwitchVodDetails(vodId: string, tenantId: string): Promise<any | null> {
  try {
    const accessToken = await getAppAccessToken(tenantId);

    const response = await axios.get('https://api.twitch.tv/helix/videos', {
      params: { id: vodId },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID || '',
      },
      timeout: 10000,
    });

    if (!response.data.data || response.data.data.length === 0) {
      return null;
    }

    return response.data.data[0];
  } catch (error: any) {
    console.error(`[Twitch] Failed to get VOD details for ${vodId}:`, error.message);
    return null;
  }
}
