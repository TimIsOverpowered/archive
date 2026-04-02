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
  } | null;
  thumbnail?: {
    src: string | null;
    srcset?: string | null;
  } | null;
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
    });

    if (!result.success) {
      logger.warn({ username }, `[Kick] Failed to reach API endpoint for ${username}`);
      return null;
    }

    const page = result.page;

    // Wait briefly for response to be ready (replaces legacy code's 10s sleep with shorter wait)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();

    try {
      const data = JSON.parse(content);

      if (!data || !data.id) {
        logger.debug({ username }, `[Kick] Channel ${username} is offline (no livestream data)`);
        await page.close();
        return null;
      }

      // Extract HLS playback URL from response (Kick uses playback_url field)
      const streamData: KickStreamStatus = {
        id: String(data.id),
        session_title: data.session_title ?? null,
        created_at: data.created_at || '',
        playback_url: data.playback_url || undefined,
        viewers: data.viewers,
        slug: data.slug,
        language: data.language,
        is_mature: data.is_mature,
        category: data.category || null,
        thumbnail: data.thumbnail || null,
      };

      logger.debug({ username }, `[Kick] Live stream detected for ${username}: ID=${streamData.id}, Title="${streamData.session_title}"`);

      await page.close();
      return streamData;
    } catch (error) {
      const details = extractErrorDetails(error);
      if (!details.message.includes('Unexpected token') && !details.message.includes('JSON.parse')) {
        logger.error({ username, err: error }, `[Kick] Failed to parse JSON response from livestream endpoint`);
      }
      await page.close();
      return null;
    }
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
    });

    if (!result.success) {
      logger.warn({ username }, `[Kick] Failed to reach videos API endpoint for ${username}`);
      return null;
    }

    const page = result.page;

    // Wait briefly for response (replaces legacy code's sleep with shorter wait)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();
    const data = JSON.parse(content);

    if (!data || !Array.isArray(data)) {
      logger.debug({ username }, `[Kick] No video data found for ${username}`);
      await page.close();
      return null; // No videos exist yet
    }

    // Find matching VOD by ID (Kick uses same ID for stream and video)
    const vodObject = data.find((v: unknown) => {
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
