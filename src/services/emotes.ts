import { EmoteUpsertSchema } from '../config/schemas.js';
import { Cache, Emote } from '../constants.js';
import { withDbRetry } from '../db/streamer-client.js';
import type { DBClient } from '../db/streamer-types.js';
import { TenantContext } from '../types/context.js';
import { Platform, PLATFORMS } from '../types/platforms.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { compressData, decompressData } from '../utils/compression.js';
import { extractErrorDetails } from '../utils/error.js';
import { safeRequest } from '../utils/http-client.js';
import { getLogger } from '../utils/logger.js';
import { RedisService } from '../utils/redis-service.js';
import { publishVodUpdate } from './cache-invalidator.js';
import { invalidateEmoteCache } from './vod-cache.js';

/** Single emote from a third-party provider (FFZ, BTTV, 7TV). */
export interface EmoteData {
  id: string;
  code: string;
  flags?: number;
}

/** Emotes aggregated for a VOD from all third-party providers. */
export interface VodEmotes {
  vodId: number;
  ffz_emotes: EmoteData[];
  bttv_emotes: EmoteData[];
  seventv_emotes: EmoteData[];
}

interface FFZEmoticon {
  id: number;
  name: string;
}

interface FFZResponse {
  room?: {
    set: string;
  };
  sets?: Record<string, { emoticons?: FFZEmoticon[] }>;
}

interface BTTVEmote {
  id: string;
  code: string;
}

interface BTTVChannelResponse {
  channelEmotes?: BTTVEmote[];
  sharedEmotes?: BTTVEmote[];
}

interface SevenTVEmote {
  id: string;
  name: string;
  flags: number;
}

interface SevenTVResponse {
  emote_set?: {
    emotes?: SevenTVEmote[];
  };
}

/**
 * Fetch emote metadata from FFZ, BTTV, and 7TV APIs, then upsert to the database.
 * Supports Twitch and Kick platforms. Publishes cache invalidation on success.
 */
export interface FetchAndSaveEmotesOptions {
  publishUpdate?: boolean;
}

export async function fetchAndSaveEmotes(
  ctx: TenantContext,
  vodId: number,
  platform: Platform,
  platformId: string,
  options: FetchAndSaveEmotesOptions = {}
): Promise<void> {
  const { publishUpdate = true } = options;
  let ffzEmotes: EmoteData[] = [];
  let bttvEmotes: EmoteData[] = [];
  let sevenTvEmotes: EmoteData[] = [];

  try {
    if (platform === PLATFORMS.TWITCH && platformId != null && platformId !== '') {
      const [ffzRes, bttvChannelRes, sevenTvRes] = await Promise.all([
        safeRequest<FFZResponse>(`${Emote.FFZ_API_BASE}/${platformId}`, {}, { timeoutMs: 5000 }),
        safeRequest<BTTVChannelResponse>(
          `${Emote.BTTV_API_BASE}/users/twitch/${platformId}`,
          { channelEmotes: [], sharedEmotes: [] },
          { timeoutMs: 5000 }
        ),
        safeRequest<SevenTVResponse>(
          `${Emote.SEVENTV_API_BASE}/users/twitch/${platformId}`,
          { emote_set: {} },
          { timeoutMs: 5000 }
        ),
      ]);

      const ffzSetKey = ffzRes.room?.set ?? null;
      ffzEmotes = (ffzSetKey != null ? (ffzRes.sets?.[ffzSetKey]?.emoticons ?? []) : []).map((e) => ({
        id: String(e.id),
        code: e.name,
      }));

      bttvEmotes = [
        ...(bttvChannelRes.channelEmotes ?? []).map(({ id, code }) => ({ id, code })),
        ...(bttvChannelRes.sharedEmotes ?? []).map(({ id, code }) => ({ id, code })),
      ];

      sevenTvEmotes = (sevenTvRes.emote_set?.emotes ?? []).map((e) => ({ id: e.id, code: e.name, flags: e.flags }));
    } else if (platform === PLATFORMS.KICK && platformId != null && platformId !== '') {
      const sevenTvRes = await safeRequest<SevenTVResponse>(
        `${Emote.SEVENTV_API_BASE}/users/kick/${platformId}`,
        { emote_set: {} },
        { timeoutMs: 5000 }
      );

      ffzEmotes = [];
      bttvEmotes = [];
      sevenTvEmotes = (sevenTvRes.emote_set?.emotes ?? []).map((e) => ({ id: e.id, code: e.name, flags: e.flags }));
    }
  } catch (error) {
    getLogger().warn({ error: extractErrorDetails(error).message, vodId }, 'Failed to fetch emote data');
    return;
  }

  if (ffzEmotes.length === 0 && bttvEmotes.length === 0 && sevenTvEmotes.length === 0) {
    return;
  }

  const emoteData: VodEmotes = {
    vodId,
    ffz_emotes: ffzEmotes,
    bttv_emotes: bttvEmotes,
    seventv_emotes: sevenTvEmotes,
  };

  try {
    const validatedEmotes = EmoteUpsertSchema.parse({
      vod_id: vodId,
      ffz_emotes: emoteData.ffz_emotes,
      bttv_emotes: emoteData.bttv_emotes,
      seventv_emotes: emoteData.seventv_emotes,
    });

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      await db
        .insertInto('emotes')
        .values({
          vod_id: validatedEmotes.vod_id,
          ffz_emotes: JSON.stringify(validatedEmotes.ffz_emotes),
          bttv_emotes: JSON.stringify(validatedEmotes.bttv_emotes),
          seventv_emotes: JSON.stringify(validatedEmotes.seventv_emotes),
        })
        .onConflict((oc) =>
          oc.column('vod_id').doUpdateSet({
            ffz_emotes: JSON.stringify(validatedEmotes.ffz_emotes),
            bttv_emotes: JSON.stringify(validatedEmotes.bttv_emotes),
            seventv_emotes: JSON.stringify(validatedEmotes.seventv_emotes),
          })
        )
        .execute();
    });

    try {
      await invalidateEmoteCache(ctx.tenantId, vodId);
    } catch (error) {
      getLogger().warn({ error: extractErrorDetails(error).message, vodId }, 'Failed to invalidate emote cache');
    }
    if (publishUpdate) {
      try {
        await publishVodUpdate(ctx.tenantId, vodId);
      } catch (error) {
        getLogger().warn({ error: extractErrorDetails(error).message, vodId }, 'Failed to publish emote update');
      }
    }
  } catch {
    getLogger().error({ vodId }, 'Failed to save emotes');
  }
}

/**
 * Retrieve emotes for a VOD from Redis cache or database.
 * Compresses and caches results in Redis on cache miss.
 */
export async function getEmotesByVodId(db: DBClient, tenantId: string, vodId: number): Promise<VodEmotes | null> {
  const cacheKey = simpleKeys.emotes(tenantId, vodId);

  const redis = RedisService.getActiveClient();
  if (redis) {
    try {
      const cached = await redis.getBuffer(cacheKey);
      if (cached != null && cached.length > 0) {
        return (await decompressData(cached)) as VodEmotes;
      }
    } catch (err) {
      getLogger().warn({ err, cacheKey }, 'Emote cache read failed, falling back to DB');
    }
  }

  const emote = await db
    .selectFrom('emotes')
    .innerJoin('vods', 'vods.id', 'emotes.vod_id')
    .select([
      'emotes.vod_id',
      'emotes.ffz_emotes',
      'emotes.bttv_emotes',
      'emotes.seventv_emotes',
      'vods.id as vod_check',
    ])
    .where('emotes.vod_id', '=', vodId)
    .executeTakeFirst();

  if (!emote) {
    return null;
  }

  const result: VodEmotes = {
    vodId: emote.vod_id,
    ffz_emotes: emote.ffz_emotes ?? [],
    bttv_emotes: emote.bttv_emotes ?? [],
    seventv_emotes: emote.seventv_emotes ?? [],
  };

  if (redis) {
    try {
      const compressed = await compressData(result);
      await redis.set(cacheKey, compressed, 'EX', Cache.EMOTE_TTL);
    } catch (err) {
      getLogger().warn({ err, cacheKey }, 'Emote cache write failed');
    }
  }

  return result;
}
