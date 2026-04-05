import HLS from 'hls-parser';
import { createSession } from '../utils/cycletls.js';
import { navigateToUrl } from '../utils/puppeteer-manager.js';
import dayjs from 'dayjs';
import durationPlugin from 'dayjs/plugin/duration';
import { extractErrorDetails, createErrorContext } from '../utils/error.js';
import { sleep } from '../utils/delay.js';
import { sendVodDownloadStarted, sendVodDownloadSuccess, sendVodDownloadFailed } from '../utils/discord-alerts.js';
import { convertHlsToMp4 } from '../utils/ffmpeg.js';
import { childLogger } from '../utils/logger.js';
import { getTenantConfig } from '../config/loader.js';
import { toHHMMSS } from '../utils/formatting.js';
import { PrismaClient } from '../../generated/streamer/client.js';
import { getKickStreamStatus } from './kick-live.js';

dayjs.extend(durationPlugin);

// Kick API constants
const KICK_API_TIMEOUT_MS = 10000;
const KICK_PAGE_DELAY_MS = 2000;

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
 * Fetch best variant URL from master playlist
 */
export function getKickParsedM3u8(m3u8: string, baseURL: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!parsed || !('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    // Select highest quality variant (first one in the list)
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

export interface KickVod {
  id: string;
  slug?: string | null;
  channel_id?: number | null;
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
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`, {
    isJsonUrl: true,
  });

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const page = result.page;

  try {
    await sleep(KICK_PAGE_DELAY_MS);

    // Use extracted data from navigator if available
    let dataArray: unknown[] | undefined;
    if ('data' in result && Array.isArray(result.data)) {
      dataArray = result.data as unknown[];
    } else {
      const content = await page.content();
      try {
        dataArray = JSON.parse(content);
      } catch (error) {
        log.debug(createErrorContext(error, { channelName }), 'Failed to parse videos API response');
        return [];
      }
    }

    if (!dataArray || !Array.isArray(dataArray)) {
      return [];
    }

    const vodsData = dataArray.map((video): KickVod => {
      if (!video || typeof video !== 'object') {
        throw new Error('Invalid video object in array');
      }

      return {
        id: String((video as Record<string, unknown>).id),
        slug: ((video as Record<string, unknown>).slug as string) ?? null,
        session_title: ((video as Record<string, unknown>).session_title as string) ?? null,
        duration: (video as Record<string, unknown>).duration ? Number((video as Record<string, unknown>).duration) : null,
        created_at: String((video as Record<string, unknown>).createdAt || ''),
        source: ((video as Record<string, unknown>).source as string) ?? null,
      };
    });

    return vodsData;
  } finally {
    await page.close();
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const result = await navigateToUrl(`https://kick.com/api/v2/channels/${channelName}/videos`, {
    isJsonUrl: true,
  });

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const page = result.page;

  try {
    await sleep(KICK_PAGE_DELAY_MS);

    // Use extracted data from navigator if available
    let dataArray: unknown[] | undefined;
    if ('data' in result && Array.isArray(result.data)) {
      dataArray = result.data as unknown[];
    } else {
      const content = await page.content();
      try {
        dataArray = JSON.parse(content);
      } catch (error) {
        log.error(createErrorContext(error, { channelName }), `Failed to parse videos API for VOD ${vodId}`);
        throw new Error(`VOD ${vodId} not found`);
      }
    }

    if (!Array.isArray(dataArray)) {
      throw new Error(`VOD ${vodId} not found`);
    }

    const video = dataArray.find((v): v is Record<string, unknown> & { id: string | number } => {
      if (!v || typeof v !== 'object') return false;
      return String((v as { id?: string | number }).id ?? '') === vodId;
    });

    if (!video) {
      throw new Error(`VOD ${vodId} not found`);
    }

    return {
      id: String(video.id),
      slug: (video.slug as string) ?? null,
      session_title: (video.session_title as string) ?? null,
      duration: video.duration ? Number(video.duration) : null,
      created_at: String(video.createdAt || ''),
      source: (video.source as string) ?? null,
    };
  } finally {
    await page.close();
  }
}

/**
 * Download Kick VOD directly to MP4 using ffmpeg HLS streaming
 */
export async function downloadMP4(tenantId: string, vod: KickVod): Promise<string | null> {
  if (!vod.source) {
    throw new Error('VOD source URL not available');
  }

  const config = getTenantConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  let messageId: string | null = null;

  try {
    // Fetch and parse HLS playlist to get direct media URL
    const m3u8Url = await getKickParsedM3u8ForFfmpeg(vod.source);

    if (!m3u8Url) {
      throw new Error('Failed to parse Kick HLS playlist');
    }

    const vodPath = `${config.settings.vodPath}/${vod.id}.mp4`;

    const streamerName = config.displayName || tenantId;
    messageId = await sendVodDownloadStarted('kick', tenantId, String(vod.id), streamerName);

    // Download directly to MP4 using ffmpeg HLS streaming
    await convertHlsToMp4(m3u8Url, vodPath, { vodId: String(vod.id), isFmp4: false });

    log.info(`Downloaded ${String(vod.id)}.mp4`);

    // Success alert
    await sendVodDownloadSuccess(messageId!, 'kick', String(vod.id), vodPath, streamerName);

    return vodPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    // Failure alert
    await sendVodDownloadFailed(messageId!, 'kick', String(vod.id), errorMsg, tenantId);

    throw error;
  }
}

/**
 * Fetch Kick HLS playlist and return direct media URL suitable for ffmpeg streaming
 */
export async function getKickParsedM3u8ForFfmpeg(sourceUrl: string): Promise<string | null> {
  const session = createSession();

  try {
    const m3u8Content = await session.fetchText(sourceUrl);

    if (!m3u8Content) {
      throw new Error('Empty HLS playlist response from Kick');
    }

    let m3u8Url: string | null;

    if (sourceUrl.includes('master.m3u8')) {
      // Parse master playlist and get variant URL with 1080p60 preference
      const baseURL = sourceUrl.replace('/master.m3u8', '');
      m3u8Url = getKickParsedM3u8(m3u8Content, baseURL);

      if (!m3u8Url) {
        throw new Error('No video variants found in HLS playlist');
      }
    } else {
      // Direct media playlist - use as-is
      m3u8Url = sourceUrl;
    }

    return m3u8Url;
  } finally {
    await session.close(); // Always clean up CycleTLS session
  }
}

export default downloadMP4;

export async function getKickCategoryInfo(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await navigateToUrl(`https://kick.com/api/v1/subcategories/${slug}`, {
      isJsonUrl: true,
      timeoutMs: KICK_API_TIMEOUT_MS,
    });

    if (!result.success) return null;

    const page = result.page;
    await sleep(KICK_PAGE_DELAY_MS);

    let response: Record<string, unknown> | undefined;
    if ('data' in result && result.data !== undefined) {
      response = result.data as Record<string, unknown>;
    } else {
      const content = await page.content();
      response = JSON.parse(content);
    }

    await page.close();
    return response ?? null;
  } catch (error) {
    log.warn(createErrorContext(error, { slug }), 'Failed to fetch category info');
    return null;
  }
}

export async function updateChapterDuringDownload(vodId: number, tenantId: string, streamerClient: PrismaClient): Promise<void> {
  try {
    const config = getTenantConfig(tenantId);
    const username = config?.kick?.username;
    if (!username) {
      log.warn({ vodId }, 'Kick username not configured');
      return;
    }

    const streamData = await getKickStreamStatus(username);
    if (!streamData || !streamData.category) {
      log.debug({ vodId }, 'No active stream or category data');
      return;
    }

    const { category, created_at } = streamData;
    const currentTimeSeconds = Math.round((Date.now() - new Date(created_at).getTime()) / 1000);

    const lastChapter = await streamerClient.chapter.findFirst({
      where: { vod_id: vodId },
      orderBy: { start: 'desc' },
    });

    if (lastChapter && lastChapter.game_id === String(category.id)) {
      await streamerClient.chapter.update({
        where: { id: lastChapter.id },
        data: { end: currentTimeSeconds },
      });

      log.debug({ vodId, chapterId: lastChapter.id, currentTime: currentTimeSeconds }, 'Updated chapter end time');
      return;
    }

    if (lastChapter) {
      await streamerClient.chapter.update({
        where: { id: lastChapter.id },
        data: { end: currentTimeSeconds },
      });
      log.debug({ vodId, chapterId: lastChapter.id }, 'Closed previous chapter');
    }

    let bannerImage: string | null = null;
    if (category.slug) {
      try {
        const categoryInfo = await getKickCategoryInfo(category.slug);
        if (categoryInfo && typeof categoryInfo.banner === 'object' && categoryInfo.banner !== null) {
          bannerImage = (categoryInfo.banner as Record<string, unknown>).src as string | null;
        }
      } catch (error) {
        log.warn({ vodId, error: extractErrorDetails(error).message }, 'Failed to fetch category info');
      }
    }

    const duration = lastChapter ? toHHMMSS(currentTimeSeconds - lastChapter.start) : '00:00:00';

    await streamerClient.chapter.create({
      data: {
        vod_id: vodId,
        game_id: String(category.id),
        name: category.name,
        image: bannerImage,
        duration: duration,
        start: lastChapter ? lastChapter.start : 0,
      },
    });

    log.info({ vodId, categoryId: category.id, categoryName: category.name, startTime: lastChapter?.start || 0 }, 'Created new chapter');
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to update chapter');
  }
}

export async function finalizeKickChapters(vodId: number, finalDurationSeconds: number, streamerClient: PrismaClient): Promise<void> {
  try {
    const incompleteChapter = await streamerClient.chapter.findFirst({
      where: {
        vod_id: vodId,
        end: null,
      },
      orderBy: { start: 'desc' },
    });

    if (incompleteChapter) {
      const endDuration = finalDurationSeconds - incompleteChapter.start;

      await streamerClient.chapter.update({
        where: { id: incompleteChapter.id },
        data: {
          end: endDuration,
          duration: toHHMMSS(endDuration),
        },
      });

      log.info({ vodId, chapterId: incompleteChapter.id, finalDuration: endDuration }, 'Finalized last chapter');
    } else {
      log.debug({ vodId }, 'No incomplete chapters to finalize');
    }
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to finalize chapters');
  }
}
