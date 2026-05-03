import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { getLogger } from '../../utils/logger.js';
import { KickVod } from './vod.js';

interface KickApiResponse {
  data?: Record<string, unknown>;
  error?: string;
}

export interface KickStreamStatus {
  id: string;
  session_title?: string | null | undefined;
  created_at: string;
  playback_url?: string | null | undefined;
  viewers?: number | null | undefined;
  slug?: string | null | undefined;
  language?: string | null | undefined;
  is_mature?: boolean | null | undefined;
  category?:
    | {
        id: number;
        name?: string | null | undefined;
        slug?: string | null | undefined;
      }
    | null
    | undefined;
  thumbnail?:
    | {
        src?: string | null | undefined;
        srcset?: string | null | undefined;
      }
    | null
    | undefined;
}

export async function getKickStreamStatus(username: string): Promise<KickStreamStatus | null> {
  try {
    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    getLogger().debug({ username, apiUrl }, 'Fetching Kick livestream data');

    const result = await fetchUrl<KickApiResponse>(apiUrl, {
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

    const streamId = typeof data.id === 'string' ? data.id : typeof data.id === 'number' ? String(data.id) : '';

    if (streamId === '') {
      getLogger().debug(
        { username, availableKeys: Object.keys(data), idField: data.id },
        `Channel ${username} is offline (no livestream id in data)`
      );
      return null;
    }

    const sessionTitle = typeof data.session_title === 'string' ? data.session_title : '';
    const createdAt = typeof data.created_at === 'string' ? data.created_at : '';
    const playbackUrl =
      typeof data.playback_url === 'string' && data.playback_url !== '' ? data.playback_url : undefined;
    const viewers = typeof data.viewers === 'number' ? data.viewers : undefined;
    const slug = typeof data.slug === 'string' && data.slug !== '' ? data.slug : undefined;
    const language = typeof data.language === 'string' && data.language !== '' ? data.language : undefined;
    const isMature = typeof data.is_mature === 'boolean' ? data.is_mature : undefined;

    let category: KickStreamStatus['category'] = null;
    if (typeof data.category === 'object' && data.category !== null) {
      const cat = data.category as Record<string, unknown>;
      if ('id' in cat && typeof cat.id === 'number') {
        category = { id: Number(cat.id), name: typeof cat.name === 'string' ? cat.name : null };
      }
    }

    let thumbnail: KickStreamStatus['thumbnail'] = null;
    if (typeof data.thumbnail === 'object' && data.thumbnail !== null) {
      const thumb = data.thumbnail as Record<string, unknown>;
      if ('src' in thumb) {
        thumbnail = { src: typeof thumb.src === 'string' ? thumb.src : '', srcset: undefined };
        if ('srcset' in thumb && typeof thumb.srcset === 'string') {
          thumbnail.srcset = thumb.srcset;
        }
      }
    }

    const streamData: KickStreamStatus = {
      id: streamId,
      session_title: sessionTitle != null && sessionTitle !== '' ? sessionTitle : null,
      created_at: createdAt,
      playback_url: playbackUrl,
      viewers: viewers,
      slug: slug,
      language: language,
      is_mature: isMature,
      category: category,
      thumbnail: thumbnail,
    };

    getLogger().debug(
      { username, streamId: streamData.id, sessionTitle: streamData.session_title },
      'Kick live stream detected'
    );

    return streamData;
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
