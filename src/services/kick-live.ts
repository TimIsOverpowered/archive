import { navigateToUrl } from '../utils/puppeteer-manager.js';
import { extractErrorDetails } from '../utils/error.js';
import { logger } from '../utils/logger.js';

/**
 * Kick livestream data structure from /api/v2/channels/{username}/livestream endpoint
 */
export interface KickStreamStatus {
  id: string;
  session_title: string | null;
  created_at: string;
  playback_url?: string; // HLS master playlist URL with auth token
  viewers?: number;
  slug?: string;
  language?: string;
  is_mature?: boolean;
  category?: {
    id: number;
    name: string | null;
    slug?: string | null;
  } | null;
  thumbnail?: {
    src: string | null;
    srcset?: string | null;
  } | null;
}

interface KickApiResponse {
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * Check if a Kick user is currently live via Puppeteer scraping with real-browser protection
 */
export async function getKickStreamStatus(username: string): Promise<KickStreamStatus | null> {
  try {
    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    logger.debug({ username }, `[Kick] Fetching livestream data for ${username} from ${apiUrl}`);

    // Navigate with Turnstile handling (even API calls may trigger bot protection)
    const result = await navigateToUrl(apiUrl, {
      timeoutMs: 15000,
      dontSaveCookies: false,
      maxRetries: 2,
      isJsonUrl: true,
    });

    if (!result.success) {
      logger.warn({ username }, `[Kick] Failed to reach API endpoint for ${username}`);
      return null;
    }

    const page = result.page;

    // Wait briefly for response to be ready (replaces legacy code's 10s sleep with shorter wait)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Use extracted data from navigator if available (preferred path for isJsonUrl: true)
    let response: KickApiResponse | undefined;
    if ('data' in result && result.data !== undefined) {
      response = result.data as KickApiResponse;
    } else {
      // Fallback to manual parsing for backward compatibility or edge cases
      const content = await page.content();
      try {
        response = JSON.parse(content);
      } catch (error) {
        logger.error({ username, error: extractErrorDetails(error).message }, `[Kick] Failed to parse API response`);
        await page.close();
        return null;
      }
    }

    if (!response) {
      logger.debug({ username }, `[Kick] Channel ${username} is offline (no livestream data)`);
      await page.close();
      return null;
    }

    // Check for API error/blocked responses
    if ('error' in response && typeof response.error === 'string') {
      logger.warn({ username, error: response.error }, `[Kick] API request blocked or errored for ${username}: "${response.error}"`);
      await page.close();
      return null;
    }

    const data = response.data as Record<string, unknown> | undefined;

    if (!data || typeof data !== 'object') {
      logger.debug({ username }, `[Kick] Channel ${username} is offline (no livestream data object)`);
      await page.close();
      return null;
    }

    const streamId = String(data.id ?? '');

    if (!streamId) {
      logger.debug({ username, availableKeys: Object.keys(data), idField: data.id }, `[Kick] Channel ${username} is offline (no livestream id in data)`);
      await page.close();
      return null;
    }

    // Safe extraction with type guards
    const sessionTitle = typeof data.session_title === 'string' ? data.session_title : '';
    const createdAt = typeof data.created_at === 'string' ? data.created_at : '';
    const playbackUrl = typeof data.playback_url === 'string' && data.playback_url ? (data.playback_url as string) : undefined;
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

    logger.debug({ username }, `[Kick] Live stream detected for ${username}: ID=${streamData.id}, Title="${streamData.session_title}"`);

    await page.close();
    return streamData;
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ username, ...details }, `[Kick Live Check] Failed to get stream status for ${username}`);
    return null;
  }
}

/**
 * Immediate check for Kick VOD/video object matching current stream (NON-BLOCKING)
 */
export async function getLatestKickVodObject(username: string, expectedStreamId: string): Promise<{ id: string; title?: string; source?: string } | null> {
  try {
    const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

    logger.debug({ username }, `[Kick] Fetching video data for ${username} from ${videosUrl}`);

    // Navigate with Turnstile handling
    const result = await navigateToUrl(videosUrl, {
      timeoutMs: 15000,
      dontSaveCookies: false,
      maxRetries: 2,
      isJsonUrl: true,
    });

    if (!result.success) {
      logger.warn({ username }, `[Kick] Failed to reach videos API endpoint for ${username}`);
      return null;
    }

    const page = result.page;

    // Wait briefly for response (replaces legacy code's sleep with shorter wait)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Use extracted data from navigator if available
    let dataArray: unknown[] | undefined;
    if ('data' in result && Array.isArray(result.data)) {
      dataArray = result.data as unknown[];
    } else {
      const content = await page.content();
      try {
        dataArray = JSON.parse(content);
      } catch (error) {
        logger.error({ username, error: extractErrorDetails(error).message }, `[Kick] Failed to parse videos API response`);
        await page.close();
        return null;
      }
    }

    if (!dataArray || !Array.isArray(dataArray)) {
      logger.debug({ username }, `[Kick] No video data found for ${username}`);
      await page.close();
      return null; // No videos exist yet
    }

    // Find matching VOD by ID (Kick uses same ID for stream and video)
    const vodObject = dataArray.find((v: unknown) => {
      if (!v || typeof v !== 'object') return false;
      const vid = (v as Record<string, unknown>).id;
      return vid === expectedStreamId || String(vid ?? '') === String(expectedStreamId);
    });

    if (!vodObject) {
      logger.debug({ username, expectedStreamId }, `[Kick] Video object not found yet for stream ${expectedStreamId}`);
      await page.close();
      return null; // Not ready - caller should retry later
    }

    const vod = vodObject as Record<string, unknown>;

    logger.info({ username, expectedStreamId }, `[Kick] Video object ready! ID=${expectedStreamId}, Title="${vod.session_title || vod.title}"`);

    await page.close();

    return {
      id: String(expectedStreamId),
      title: (vod.session_title as string) || (vod.title as string),
      source: (vod.source as string) || undefined,
    };
  } catch (error) {
    const details = extractErrorDetails(error);
    logger.error({ username, ...details }, `[Kick] Failed to get video object for ${username}`);
    return null;
  }
}
