import { fetchUrl } from '../utils/flaresolverr-client.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { KICK_LIVE_API_TIMEOUT_MS } from '../constants.js';
import { LRUCache } from 'lru-cache';

const kickStreamCache = new LRUCache<string, KickStreamStatus>({
  max: 100,
  ttl: 30_000,
  allowStale: true,
});

function _cacheKickStream(username: string, status: KickStreamStatus | null): void {
  if (status === null) {
    kickStreamCache.set(username, { id: '__offline__', session_title: null, created_at: '' } as KickStreamStatus);
    return;
  }
  kickStreamCache.set(username, status);
}

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

/**
 * Check if a Kick user is currently live via Puppeteer scraping with real-browser protection
 */
export async function getKickStreamStatus(username: string): Promise<KickStreamStatus | null> {
  const cached = kickStreamCache.get(username);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    getLogger().debug({ username }, `[Kick] Fetching livestream data for ${username} from ${apiUrl}`);

    const result = await fetchUrl<KickApiResponse>(apiUrl, {
      timeoutMs: KICK_LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn({ username }, `[Kick] Failed to reach API endpoint for ${username}`);
      _cacheKickStream(username, null);
      return null;
    }

    const response = result.data;

    if (!response) {
      getLogger().debug({ username }, `[Kick] Channel ${username} is offline (no livestream data)`);
      _cacheKickStream(username, null);
      return null;
    }

    // Check for API error/blocked responses
    if ('error' in response && typeof response.error === 'string') {
      getLogger().warn(
        { username, error: response.error },
        `[Kick] API request blocked or errored for ${username}: "${response.error}"`
      );
      _cacheKickStream(username, null);
      return null;
    }

    const data = response.data as Record<string, unknown> | undefined;

    if (!data || typeof data !== 'object') {
      getLogger().debug({ username }, `[Kick] Channel ${username} is offline (no livestream data object)`);
      _cacheKickStream(username, null);
      return null;
    }

    const streamId = String(data.id ?? '');

    if (!streamId) {
      getLogger().debug(
        { username, availableKeys: Object.keys(data), idField: data.id },
        `[Kick] Channel ${username} is offline (no livestream id in data)`
      );
      _cacheKickStream(username, null);
      return null;
    }

    // Safe extraction with type guards
    const sessionTitle = typeof data.session_title === 'string' ? data.session_title : '';
    const createdAt = typeof data.created_at === 'string' ? data.created_at : '';
    const playbackUrl =
      typeof data.playback_url === 'string' && data.playback_url ? (data.playback_url as string) : undefined;
    const viewers = typeof data.viewers === 'number' ? (data.viewers as number) : undefined;
    const slug = typeof data.slug === 'string' && data.slug ? (data.slug as string) : undefined;
    const language = typeof data.language === 'string' && data.language ? (data.language as string) : undefined;
    const isMature = typeof data.is_mature === 'boolean' ? (data.is_mature as boolean) : undefined;

    let category: KickStreamStatus['category'] = null;
    if (typeof data.category === 'object' && data.category !== null) {
      const cat = data.category as Record<string, unknown>;
      if ('id' in cat && typeof cat.id === 'number') {
        category = { id: Number(cat.id), name: typeof cat.name === 'string' ? (cat.name as string | null) : null };
      }
    }

    let thumbnail: KickStreamStatus['thumbnail'] = null;
    if (typeof data.thumbnail === 'object' && data.thumbnail !== null) {
      const thumb = data.thumbnail as Record<string, unknown>;
      if ('src' in thumb) {
        thumbnail = { src: typeof thumb.src === 'string' ? (thumb.src as string | null) : '', srcset: undefined };
        if ('srcset' in thumb && typeof thumb.srcset === 'string') {
          thumbnail.srcset = thumb.srcset as string;
        }
      }
    }

    const streamData: KickStreamStatus = {
      id: streamId,
      session_title: sessionTitle || null,
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
      { username },
      `[Kick] Live stream detected for ${username}: ID=${streamData.id}, Title="${streamData.session_title}"`
    );

    _cacheKickStream(username, streamData);
    return streamData;
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, `[Kick Live Check] Failed to get stream status for ${username}`);
    throw error;
  }
}

/**
 * Immediate check for Kick VOD/video object matching current stream (NON-BLOCKING)
 */
export async function getLatestKickVodObject(
  username: string,
  expectedStreamId: string
): Promise<{ id: string; title?: string | undefined; source?: string | undefined } | null> {
  try {
    const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

    getLogger().debug({ username }, `[Kick] Fetching video data for ${username} from ${videosUrl}`);

    const result = await fetchUrl<unknown[]>(videosUrl, {
      timeoutMs: KICK_LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn({ username }, `[Kick] Failed to reach videos API endpoint for ${username}`);
      return null;
    }

    const dataArray = result.data;

    if (!dataArray || !Array.isArray(dataArray)) {
      getLogger().debug({ username }, `[Kick] No video data found for ${username}`);
      return null; // No videos exist yet
    }

    // Find matching VOD by ID (Kick uses same ID for stream and video)
    const vodObject = dataArray.find((v: unknown) => {
      if (!v || typeof v !== 'object') return false;
      const vid = (v as Record<string, unknown>).id;
      return vid === expectedStreamId || String(vid ?? '') === String(expectedStreamId);
    });

    if (!vodObject) {
      getLogger().debug(
        { username, expectedStreamId },
        `[Kick] Video object not found yet for stream ${expectedStreamId}`
      );
      return null; // Not ready - caller should retry later
    }

    const vod = vodObject as Record<string, unknown>;

    getLogger().debug(
      { username, expectedStreamId },
      `[Kick] Video object ready! ID=${expectedStreamId}, Title="${vod.session_title || vod.title}"`
    );

    return {
      id: String(expectedStreamId),
      title: vod.session_title as string,
      source: (vod.source as string) || undefined,
    };
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, `[Kick] Failed to get video object for ${username}`);
    throw error;
  }
}
