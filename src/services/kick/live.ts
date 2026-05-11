import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { getLogger } from '../../utils/logger.js';
import { KickVod } from './vod.js';

export interface KickCategoryRaw {
  id: number;
  name?: string;
  slug?: string;
  tags?: string[];
  parent_category?: { id: number; slug: string };
}

interface KickThumbnailRaw {
  src?: string;
  srcset?: string;
}

export interface KickLiveStreamRaw {
  id: number | string;
  slug?: string;
  session_title?: string;
  created_at: string;
  language?: string;
  is_mature?: boolean;
  viewers?: number;
  category?: KickCategoryRaw | null;
  playback_url?: string;
  thumbnail?: KickThumbnailRaw | null;
}

interface KickLiveApiResponse {
  data?: KickLiveStreamRaw | null;
  error?: string;
}

export interface KickBannerImage {
  src?: string;
}

export interface KickCategoryInfo {
  id: number;
  name?: string;
  slug?: string;
  banner?: KickBannerImage | null;
}

export async function getKickStreamStatus(username: string): Promise<KickLiveStreamRaw | null> {
  try {
    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    getLogger().debug({ username, apiUrl }, 'Fetching Kick livestream data');

    const result = await fetchUrl<KickLiveApiResponse>(apiUrl, {
      timeoutMs: Kick.LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn({ username, code: result.code, error: result.error }, 'Failed to reach Kick API endpoint');
      return null;
    }

    const response = result.data;

    if (response == null) {
      getLogger().debug({ username }, 'Kick channel is offline (no livestream data)');
      return null;
    }

    if ('error' in response && typeof response.error === 'string') {
      getLogger().warn({ username, error: response.error }, 'Kick API request blocked or errored');
      return null;
    }

    const data = response.data;

    if (!data || typeof data !== 'object') {
      getLogger().debug({ username }, 'Kick channel is offline (no livestream data object)');
      return null;
    }

    if (typeof data.id !== 'number' && typeof data.id !== 'string') {
      getLogger().debug(
        { username, availableKeys: Object.keys(data), idField: data.id },
        `Channel ${username} is offline (no livestream id in data)`
      );
      return null;
    }

    getLogger().debug({ username, streamId: data.id, sessionTitle: data.session_title }, 'Kick live stream detected');

    return data;
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, 'Failed to get Kick stream status');
    throw error;
  }
}

export async function getLatestKickVodObject(username: string, expectedStreamId: string): Promise<KickVod | null> {
  try {
    const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

    getLogger().debug({ username, videosUrl }, 'Fetching Kick video data');

    const result = await fetchUrl<unknown[]>(videosUrl, {
      timeoutMs: Kick.LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn(
        { username, code: result.code, error: result.error },
        'Failed to reach Kick videos API endpoint'
      );
      return null;
    }

    const dataArray = result.data as unknown as KickVod[];

    if (dataArray == null || !Array.isArray(dataArray)) {
      getLogger().debug({ username }, 'Kick has no video data');
      return null;
    }

    const vodObject = dataArray.find((v: KickVod) => {
      if (v == null || typeof v !== 'object') return false;
      return String(v.id) == expectedStreamId;
    });

    if (vodObject == null) {
      getLogger().debug({ username, expectedStreamId }, 'Kick video object not found yet');
      return null;
    }

    getLogger().debug({ username, expectedStreamId, title: vodObject.session_title }, 'Kick video object ready');

    return vodObject;
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, 'Failed to get Kick video object');
    throw error;
  }
}
