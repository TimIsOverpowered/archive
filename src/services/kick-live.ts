import puppeteer, { Browser } from 'puppeteer';
import { extractErrorDetails } from '../utils/error.js';
import { logger } from '../utils/logger.js';

let browserInstance: Browser | null = null;

/**
 * Initialize Puppeteer browser instance (singleton for PM2 process)
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
    }

    logger.info('[Kick Live] Initializing Puppeteer browser...');

    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    logger.info('[Kick Live] Browser initialized successfully');
  }

  return browserInstance;
}

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
 * Check if a Kick user is currently live via Puppeteer scraping
 */
export async function getKickStreamStatus(username: string): Promise<KickStreamStatus | null> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    // Set timeout and headers to mimic real browser
    page.setDefaultTimeout(15000);
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    logger.debug({ username }, `[Kick] Fetching livestream data for ${username} from ${apiUrl}`);

    await page.goto(apiUrl, {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });

    // Wait a bit for response to be ready (legacy code uses 10s sleep)
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
    } catch (parseError) {
      logger.error({ username }, `[Kick] Failed to parse JSON response from livestream endpoint:`, parseError);
      await page.close();
      return null;
    }
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    logger.error({ username, err: message }, `[Kick Live Check] Failed to get stream status for ${username}`);
    return null;
  }
}

/**
 * Immediate check for Kick VOD/video object matching current stream (NON-BLOCKING)
 * Returns immediately with result or null if not ready yet - matches legacy behavior
 */
export async function getLatestKickVodObject(username: string, expectedStreamId: string): Promise<{ id: string; title?: string; source?: string } | null> {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    page.setDefaultTimeout(15000);

    const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

    logger.debug({ username }, `[Kick] Fetching video data for ${username} from ${videosUrl}`);

    await page.goto(videosUrl, {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });

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
      const vid = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).id : undefined;
      return vid === expectedStreamId || String(vid ?? '') === String(expectedStreamId);
    });

    if (!vodObject) {
      logger.debug({ username, expectedStreamId }, `[Kick] Video object not found yet for stream ${expectedStreamId}`);
      await page.close();
      return null; // Not ready - caller should retry later
    }

    logger.info({ username, expectedStreamId }, `[Kick] Video object ready! ID=${expectedStreamId}, Title="${vodObject.session_title || vodObject.title}"`);

    await page.close();

    return {
      id: String(expectedStreamId),
      title: vodObject.session_title || vodObject.title,
      source: vodObject.source || undefined,
    };
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    logger.error({ username, err: message }, `[Kick] Failed to get video object for ${username}`);
    return null;
  }
}

/**
 * Clean up browser instance on shutdown
 */
export async function closeKickBrowser(): Promise<void> {
  if (browserInstance && browserInstance.isConnected()) {
    logger.info('[Kick Live] Closing Puppeteer browser...');
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
