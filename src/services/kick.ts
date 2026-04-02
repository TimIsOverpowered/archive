import HLS from 'hls-parser';
import { createSession } from '../utils/cycletls.js';
import { navigateToUrl } from '../utils/puppeteer-manager.js';
import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import { extractErrorDetails } from '../utils/error.js';
import { sendRichAlert, updateDiscordEmbed, isAlertsEnabled } from '../utils/discord-alerts.js';
import { convertHlsToMp4 } from '../utils/ffmpeg.js';
import { childLogger } from '../utils/logger.js';
import { getStreamerConfig } from '../config/loader.js';

dayjs.extend(durationPlugin);

const log = childLogger({ module: 'kick' });

/**
 * Fetches Kick's HLS playlist using cycletls (JA3 fingerprinting).
 */
export async function getKickM3u8(sourceUrl: string): Promise<string> {
  const session = createSession();

  try {
    return await session.fetchText(sourceUrl);
  } finally {
    await session.close();
  }
}

/**
 * Extract best variant URL from master playlist - matches reference getParsedM3u8 (lines 207-216)
 */
export function getKickParsedM3u8(m3u8: string, baseURL: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!parsed || !('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    // Select highest quality variant (first one in the list) - matches reference line 214-215
    const bestVariant = parsed.variants[0];

    if (!bestVariant.uri) {
      return null;
    }

    return `${baseURL}/${bestVariant.uri}`;
  } catch (error) {
    const details = extractErrorDetails(error);
    log.debug({ details }, 'Failed to parse HLS master playlist');
    return null;
  }
}

/**
 * Live stream data structure - matches reference getStream (lines 48-73)
 */
export interface KickStreamStatus {
  id: string;
  session_title?: string | null;
  created_at: string;
  playback_url?: string | null; // HLS master playlist URL with auth token
  viewers?: number | null;
  slug?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  category?: {
    id: number;
    name?: string | null;
    slug?: string | null;
  } | null;
}

export interface KickVod {
  id: string;
  slug?: string | null;
  channel_id?: number | null;
  title?: string | null;
  session_title?: string | null;
  duration?: number | null;
  views?: number | null;
  published_at?: string | null;
  created_at: string;
  source?: string | null;
  is_live?: boolean | null;
  start_time?: string | null;
  language?: string | null;
  is_mature?: boolean | null;
  viewer_count?: number | null;
  tags?: string[] | null;
  thumbnail?: {
    src?: string | null;
    srcset?: string | null;
  } | null;
}

export async function getVods(channelName: string): Promise<KickVod[]> {
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`);

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries'); // Updated message - matches reference line 75-100 pattern
  }

  const page = result.page;

  try {
    // Wait briefly for response to be ready (replaces legacy code's 10s sleep with shorter wait) - matches reference line 85-96 pattern
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();

    try {
      const data = JSON.parse(content); // Parse API response directly (not Next.js script) - matches reference lines 75-100

      if (!data || !Array.isArray(data)) {
        return [];
      }

      // Map raw video objects to KickVod interface - matches reference line 92-96 pattern
      const vodsData = data.map((video: Record<string, unknown>) => ({
        id: String(video.id),
        slug: (video.slug as string) ?? null,
        title: (video.title as string) ?? null,
        session_title: (video.session_title as string) ?? null,
        duration: video.duration ? Number(video.duration) : null,
        views: video.views ? Number(video.views) : null,
        published_at: (video.publishedAt as string) ?? null,
        created_at: String(video.createdAt || ''),
        source: (video.source as string) ?? null,
      }));

      return vodsData; // Return mapped VOD array - matches reference line 96 pattern
    } catch (error) {
      const details = extractErrorDetails(error);
      log.debug({ channelName, details }, 'Failed to parse videos API JSON response');
      return []; // Empty on parse error
    }
  } finally {
    await page.close();
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`); // Use API endpoint instead of Next.js page - matches reference line 103-134 pattern

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const page = result.page;

  try {
    // Wait briefly for response (replaces legacy code's sleep with shorter wait) - matches reference line 108-129 pattern
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const content = await page.content();
    const data: Record<string, unknown>[] = JSON.parse(content); // Parse API response directly (not Next.js script) - matches reference lines 75-100 pattern

    if (!Array.isArray(data)) {
      throw new Error(`VOD ${vodId} not found`);
    }

    // Find matching VOD by ID (matches reference line 128-134: jsonContent.find((livestream) => livestream.id.toString() === vodId))
    const video = data.find((v) => v && String(v?.id) === vodId);

    if (!video || typeof video !== 'object') {
      throw new Error(`VOD ${vodId} not found`);
    }

    return {
      id: String(video.id),
      slug: (video.slug as string) ?? null,
      title: (video.title as string) ?? null,
      session_title: (video.session_title as string) ?? null,
      duration: video.duration ? Number(video.duration) : null,
      views: video.views ? Number(video.views) : null,
      published_at: (video.publishedAt as string) ?? null,
      created_at: String(video.createdAt || ''),
      source: (video.source as string) ?? null,
    };
  } finally {
    await page.close();
  }
}

/**
 * Download Kick VOD directly to MP4 using ffmpeg HLS streaming (reference: kick.js line 136-205)
 */
export async function downloadMP4(streamerId: string, vod: KickVod): Promise<string | null> {
  if (!vod.source) {
    throw new Error('VOD source URL not available');
  }

  const config = getStreamerConfig(streamerId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${streamerId}`);
  }

  let messageId: string | null = null;

  try {
    // Fetch and parse HLS playlist to get direct media URL (reference kick.js line 175-205)
    const m3u8Url = await getKickParsedM3u8ForFfmpeg(vod.source);

    if (!m3u8Url) {
      throw new Error('Failed to parse Kick HLS playlist');
    }

    const vodPath = `${config.settings.vodPath}/${vod.id}.mp4`;

    // Send Discord "Download Started" alert
    if (isAlertsEnabled()) {
      try {
        const streamerName = config.displayName || streamerId;

        messageId = await sendRichAlert({
          title: '📥 Kick VOD Download Started',
          description: `${vod.id} download in progress for ${streamerName}`,
          status: 'warning',
          fields: [
            { name: 'VOD ID', value: `\`${String(vod.id)}\``, inline: false },
            { name: 'Streamer', value: `\`${streamerName}\`` },
          ],
          timestamp: new Date().toISOString(),
        });
      } catch {} // Silent fail for alerts
    }

    // Download directly to MP4 using ffmpeg HLS streaming (reference kick.js line 160-205, consolidated in ffmpeg.ts)
    // Kick always uses .ts segments (per platform specification)
    await convertHlsToMp4(m3u8Url, vodPath, { vodId: String(vod.id), isFmp4: false });

    console.info(`Downloaded ${String(vod.id)}.mp4`); // Reference pattern kick.js line 160-205

    // Success alert
    if (isAlertsEnabled() && messageId) {
      try {
        const streamerName = config.displayName || streamerId;

        await updateDiscordEmbed(messageId, {
          title: '✅ Kick VOD Download Complete!',
          description: `${vod.id} successfully downloaded and converted to MP4 for ${streamerName}`,
          status: 'success',
          fields: [
            { name: 'VOD ID', value: `\`${String(vod.id)}\``, inline: false },
            { name: 'Output Path', value: vodPath, inline: false },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      } catch {} // Silent fail for alerts
    }

    return vodPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    console.error(`\nffmpeg error occurred: ${errorMsg}`); // Reference pattern kick.js line 163-205

    // Failure alert
    if (isAlertsEnabled() && messageId) {
      try {
        await updateDiscordEmbed(messageId, {
          title: '❌ Kick VOD Download Failed',
          description: `${vod.id} download failed for ${streamerId}`,
          status: 'error',
          fields: [
            { name: 'VOD ID', value: `\`${String(vod.id)}\``, inline: false },
            { name: 'Error', value: errorMsg, inline: false },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      } catch {} // Silent fail for alerts
    }

    throw error;
  }
}

/**
 * Fetch Kick HLS playlist and return direct media URL suitable for ffmpeg streaming
 */
async function getKickParsedM3u8ForFfmpeg(sourceUrl: string): Promise<string | null> {
  const session = createSession();

  try {
    // Fetch master playlist using CycleTLS (reference kick.js line 175-205)
    const m3u8Content = await session.fetchText(sourceUrl);

    if (!m3u8Content) {
      throw new Error('Empty HLS playlist response from Kick');
    }

    let m3u8Url: string | null;

    if (sourceUrl.includes('master.m3u8')) {
      // Parse master playlist and get variant URL with 1080p60 preference (reference kick.js line 207-216)
      const baseURL = sourceUrl.replace('/master.m3u8', '');
      m3u8Url = getKickParsedM3u8(m3u8Content, baseURL);

      if (!m3u8Url) {
        throw new Error('No video variants found in HLS playlist');
      }
    } else {
      // Direct media playlist - use as-is (reference kick.js line 179-205 pattern)
      m3u8Url = sourceUrl;
    }

    return m3u8Url;
  } finally {
    await session.close(); // Always clean up CycleTLS session (reference kick.js line 509 pattern)
  }
}

export default downloadMP4;
