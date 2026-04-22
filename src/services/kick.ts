import HLS from 'hls-parser';
import dayjs from 'dayjs';
import { createSession } from '../utils/cycletls.js';
import { fetchUrl } from '../utils/flaresolverr-client.js';
import { extractErrorDetails, createErrorContext } from '../utils/error.js';
import { childLogger } from '../utils/logger.js';
import { toHHMMSS } from '../utils/formatting.js';
import { getKickStreamStatus } from './kick-live.js';
import { KICK_API_TIMEOUT_MS, KICK_API_BASE, KICK_SUBCATEGORIES_URL } from '../constants.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/client.js';
import { LRUCache } from 'lru-cache';
import { ChapterCreateSchema, ChapterUpdateSchema } from '../config/schemas.js';
import { publishVodUpdate } from './cache-invalidator.js';

const log = childLogger({ module: 'kick' });

const kickCategoryCache = new LRUCache<string, Record<string, unknown>>({
  max: 500,
  ttl: 7 * 24 * 60 * 60 * 1000,
  allowStale: false,
});

function getKickParsedM3u8(m3u8: string, baseURL: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!parsed || !('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    const bestVariant = parsed.variants[0];
    if (!bestVariant) return null;

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
  id: number;
  slug: string | null;
  channel_id: number;
  created_at: string;
  session_title: string | null;
  is_live: boolean;
  risk_level_id: number | null;
  start_time: string | null;
  source: string | null;
  twitch_channel: string | null;
  duration: number;
  language: string | null;
  is_mature: boolean;
  viewer_count: number | null;
  tags: string[] | null;
  thumbnail: {
    src: string | null;
    srcset: string | null;
  } | null;
  views: number | null;
  video: {
    id: number;
    live_stream_id: number;
    slug: string | null;
    thumb: string | null;
    s3: string | null;
    trading_platform_id: number | null;
    created_at: string;
    updated_at: string;
    uuid: string;
    views: number;
    deleted_at: string | null;
    is_pruned: boolean;
    is_private: boolean;
    status: string;
  } | null;
  categories: Array<{
    id: number;
    category_id: number;
    name: string;
    slug: string;
    tags: string[];
    description: string | null;
    deleted_at: string | null;
    is_mature: boolean;
    is_promoted: boolean;
    viewers: number;
    is_fallback: boolean;
    banner: {
      responsive: string | null;
      url: string | null;
    } | null;
  }> | null;
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  const result = await fetchUrl<KickVod[]>(`${KICK_API_BASE}/api/v2/channels/${channelName}/videos`);

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const dataArray = result.data;

  if (!Array.isArray(dataArray)) {
    throw new Error(`VOD ${vodId} not found`);
  }

  const video = dataArray.find((v): v is KickVod => {
    if (!v || typeof v !== 'object') return false;
    return v.id === Number(vodId);
  });

  if (!video) {
    throw new Error(`VOD ${vodId} not found`);
  }

  return video;
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

export async function getKickCategoryInfo(slug: string): Promise<Record<string, unknown> | null> {
  const cached = kickCategoryCache.get(slug);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const result = await fetchUrl<Record<string, unknown>>(`${KICK_SUBCATEGORIES_URL}/${slug}`, {
      timeoutMs: KICK_API_TIMEOUT_MS,
    });

    if (!result.success) return null;

    const response = result.data;
    const cachedResult = response ?? null;
    if (cachedResult) {
      kickCategoryCache.set(slug, cachedResult as Record<string, unknown>);
    }
    return cachedResult;
  } catch (error) {
    log.warn(createErrorContext(error, { slug }), 'Failed to fetch category info');
    return null;
  }
}

export async function updateChapterDuringDownload(ctx: TenantContext, dbId: number, vodId: string): Promise<void> {
  try {
    const { config } = ctx;
    const username = config?.kick?.username;
    if (!username) {
      log.warn({ dbId, vodId }, 'Kick username not configured');
      return;
    }

    const streamData = await getKickStreamStatus(username);
    if (!streamData || !streamData.category) {
      log.debug({ dbId, vodId }, 'No active stream or category data');
      return;
    }

    const { category, created_at } = streamData;
    const currentTimeSeconds = dayjs().diff(created_at, 'second');

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const lastChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (lastChapter && lastChapter.game_id === String(category.id)) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db.updateTable('chapters').set({ end: currentTimeSeconds }).where('id', '=', lastChapter.id).execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug({ vodId, chapterId: lastChapter.id, currentTime: currentTimeSeconds }, 'Updated chapter end time');
        return;
      }

      if (lastChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db.updateTable('chapters').set({ end: currentTimeSeconds }).where('id', '=', lastChapter.id).execute();

        await publishVodUpdate(ctx.tenantId, dbId);

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

      const existingChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('start', '=', currentTimeSeconds)
        .executeTakeFirst();

      if (existingChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db
          .updateTable('chapters')
          .set({ end: currentTimeSeconds })
          .where('id', '=', existingChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug(
          { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: currentTimeSeconds },
          'Created new chapter'
        );
        return;
      }

      const duration = lastChapter ? toHHMMSS(currentTimeSeconds - lastChapter.start) : '00:00:00';

      const validatedChapter = ChapterCreateSchema.parse({
        vod_id: dbId,
        start: currentTimeSeconds,
        duration,
        title: category.name,
        game_id: String(category.id),
      });
      await db
        .insertInto('chapters')
        .values({
          vod_id: validatedChapter.vod_id,
          game_id: validatedChapter.game_id,
          name: validatedChapter.title,
          image: bannerImage,
          duration: validatedChapter.duration,
          start: validatedChapter.start,
        })
        .execute();

      await publishVodUpdate(ctx.tenantId, dbId);

      log.debug(
        { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: currentTimeSeconds },
        'Created new chapter'
      );
    });
  } catch (error) {
    log.error(createErrorContext(error, { dbId, vodId }), 'Failed to update chapter');
  }
}

export async function finalizeKickChapters(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  finalDurationSeconds: number
): Promise<void> {
  try {
    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const incompleteChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('end', 'is', null)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (incompleteChapter) {
        const endDuration = finalDurationSeconds - incompleteChapter.start;

        ChapterUpdateSchema.parse({
          end: endDuration,
          duration: toHHMMSS(endDuration),
        });
        await db
          .updateTable('chapters')
          .set({
            end: endDuration,
            duration: toHHMMSS(endDuration),
          })
          .where('id', '=', incompleteChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.info({ vodId, chapterId: incompleteChapter.id, finalDuration: endDuration }, 'Finalized last chapter');
      } else {
        log.debug({ vodId }, 'No incomplete chapters to finalize');
      }
    });
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to finalize chapters');
  }
}
