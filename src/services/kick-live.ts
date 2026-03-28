import puppeteer, { Browser } from 'puppeteer';

let browserInstance: Browser | null = null;

/**
 * Initialize Puppeteer browser instance (singleton for PM2 process)
 */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    if (browserInstance) {
      await browserInstance.close().catch(() => {});
    }

    console.info('[Kick Live] Initializing Puppeteer browser...');

    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    console.info('[Kick Live] Browser initialized successfully');
  }

  return browserInstance;
}

/**
 * Kick livestream data structure from /api/v2/channels/{username}/livestream endpoint
 */
export interface KickStreamStatus {
  id: number;
  session_title: string;
  created_at: string;
  source?: string; // HLS master playlist URL
  channel_id: number;
  viewer_count?: number;
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

    console.debug(`[Kick] Fetching livestream data for ${username} from ${apiUrl}`);

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
        console.debug(`[Kick] Channel ${username} is offline (no livestream data)`);
        await page.close();
        return null;
      }

      // Extract HLS source URL from response
      const streamData: KickStreamStatus = {
        id: data.id,
        session_title: data.session_title || '',
        created_at: data.created_at,
        source: data.source || undefined,
        channel_id: data.channel?.id || 0,
        viewer_count: data.viewer_count || 0,
      };

      console.debug(`[Kick] Live stream detected for ${username}: ID=${streamData.id}, Title="${streamData.session_title}"`);

      await page.close();
      return streamData;
    } catch (parseError) {
      console.error(`[Kick] Failed to parse JSON response from livestream endpoint:`, parseError);
      await page.close();
      return null;
    }
  } catch (error: any) {
    console.error(`[Kick Live Check] Failed to get stream status for ${username}:`, error.message);
    return null;
  }
}

/**
 * Wait for Kick VOD object to appear in their system after live detection
 * Note: For Kick, the livestream ID IS the permanent ID, but we still wait for metadata finalization
 */
export async function waitForKickVodObject(username: string, streamId: number): Promise<{ id: string; title?: string; source?: string } | null> {
  const maxAttempts = 12; // ~60 seconds (5s * 12) - shorter since Kick uses same ID throughout

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds between attempts

    try {
      const browser = await getBrowser();
      const page = await browser.newPage();

      page.setDefaultTimeout(15000);

      const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

      await page.goto(videosUrl, {
        waitUntil: 'networkidle0',
        timeout: 15000,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const content = await page.content();
      const data = JSON.parse(content);

      if (!data || !Array.isArray(data)) {
        await page.close();
        continue;
      }

      // Find matching VOD by ID (Kick uses same ID for stream and video)
      const vodObject = data.find((v: any) => v.id === streamId || String(v.id) === String(streamId));

      if (vodObject) {
        console.info(`[Kick] Video object found in system: ID=${streamId}, Title="${vodObject.session_title || vodObject.title}"`);

        await page.close();

        return {
          id: String(streamId),
          title: vodObject.session_title || vodObject.title,
          source: vodObject.source || undefined,
        };
      }

      await page.close();
    } catch (error: any) {
      console.warn(`[Kick] Attempt ${attempt + 1}/${maxAttempts} failed while waiting for video object:`, error.message);
    }
  }

  // Return basic info even if VOD object not found - Kick uses stream ID as permanent identifier
  console.info(`[Kick] Using livestream ID directly (video object may still be processing)`);

  return {
    id: String(streamId),
  };
}

/**
 * Clean up browser instance on shutdown
 */
export async function closeKickBrowser(): Promise<void> {
  if (browserInstance && browserInstance.isConnected()) {
    console.info('[Kick Live] Closing Puppeteer browser...');
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

// Graceful shutdown handler
process.on('SIGTERM', () => closeKickBrowser());
process.on('SIGINT', () => closeKickBrowser());
