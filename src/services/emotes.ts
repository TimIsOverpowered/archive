import { getLogger } from '../utils/logger.js';
import type { DBClient } from '../db/streamer-types.js';
import { Platform, PLATFORMS } from '../types/platforms.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/streamer-client.js';
import { safeRequest } from '../utils/http-client.js';
import { RedisService } from '../utils/redis-service.js';
import { compressChatData, decompressChatData } from '../utils/compression.js';
import { EMOTE_CACHE_TTL, FFZ_API_BASE, BTTV_API_BASE, SEVENTV_API_BASE } from '../constants.js';
import { EmoteUpsertSchema } from '../config/schemas.js';
import { invalidateEmoteCache } from './vod-cache.js';
import { publishVodUpdate } from './cache-invalidator.js';
import { CacheKeys } from '../utils/cache-keys.js';

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

interface FFZResponse {
  channels?: Record<
    string,
    {
      emotes?: Array<{
        id: number;
        code: string;
      }>;
    }
  >;
}

interface BTTVGlobalResponse {
  emotes?: Array<{
    id: string;
    code: string;
  }>;
}

interface BTTVChannelResponse {
  channelEmotes?: Array<{
    id: string;
    code: string;
  }>;
}

interface SevenTVResponse {
  emotes?: Array<{
    id: string;
    name: string;
    flags: number;
  }>;
}

/**
 * Fetch emote metadata from FFZ, BTTV, and 7TV APIs, then upsert to the database.
 * Supports Twitch and Kick platforms. Publishes cache invalidation on success.
 */
export async function fetchAndSaveEmotes(
  ctx: TenantContext,
  vodId: number,
  platform: Platform,
  platformId: string
): Promise<void> {
  let ffzEmotes: EmoteData[] = [];
  let bttvEmotes: EmoteData[] = [];
  let sevenTvEmotes: EmoteData[] = [];

  if (platform === PLATFORMS.TWITCH && platformId) {
    const [ffzRes, bttvGlobalRes, bttvChannelRes, sevenTvRes, sevenTvGlobalRes] = await Promise.all([
      safeRequest<FFZResponse>(`${FFZ_API_BASE}/${platformId}`, {}, { timeoutMs: 5000 }),
      safeRequest<BTTVGlobalResponse>(`${BTTV_API_BASE}/emotes/global`, { emotes: [] }, { timeoutMs: 5000 }),
      safeRequest<BTTVChannelResponse>(
        `${BTTV_API_BASE}/users/twitch/${platformId}`,
        { channelEmotes: [] },
        { timeoutMs: 5000 }
      ),
      safeRequest<SevenTVResponse>(
        `${SEVENTV_API_BASE}/users/twitch/${platformId}`,
        { emotes: [] },
        { timeoutMs: 5000 }
      ),
      safeRequest<SevenTVResponse>(`${SEVENTV_API_BASE}/emote-sets/global`, { emotes: [] }, { timeoutMs: 5000 }),
    ]);

    ffzEmotes =
      ((ffzRes as FFZResponse).channels?.[platformId]?.emotes || []).map((e) => ({ id: String(e.id), code: e.code })) ||
      [];

    bttvEmotes = [
      ...(bttvGlobalRes.emotes || []).map(({ id, code }) => ({ id, code })),
      ...(((bttvChannelRes as BTTVChannelResponse).channelEmotes || [])?.map(({ id, code }) => ({ id, code })) || []),
    ];

    sevenTvEmotes = [
      ...((sevenTvGlobalRes as SevenTVResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags })),
      ...((sevenTvRes as SevenTVResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags })),
    ];
  } else if (platform === PLATFORMS.KICK && platformId) {
    const [sevenTvRes, sevenTvGlobalRes] = await Promise.all([
      safeRequest<SevenTVResponse>(
        `${SEVENTV_API_BASE}/users/twitch/${platformId}`,
        { emotes: [] },
        { timeoutMs: 5000 }
      ),
      safeRequest<SevenTVResponse>(`${SEVENTV_API_BASE}/emote-sets/global`, { emotes: [] }, { timeoutMs: 5000 }),
    ]);

    ffzEmotes = [];
    bttvEmotes = [];
    sevenTvEmotes = [
      ...((sevenTvGlobalRes as SevenTVResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags })),
      ...((sevenTvRes as SevenTVResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags })),
    ];
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
    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const validatedEmotes = EmoteUpsertSchema.parse({
        vod_id: vodId,
        ffz_emotes: emoteData.ffz_emotes,
        bttv_emotes: emoteData.bttv_emotes,
        seventv_emotes: emoteData.seventv_emotes,
      });
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

      await invalidateEmoteCache(ctx.tenantId, vodId);
      await publishVodUpdate(ctx.tenantId, vodId);
    });
  } catch {
    getLogger().error({ vodId }, 'Failed to save emotes');
  }
}

/**
 * Retrieve emotes for a VOD from Redis cache or database.
 * Compresses and caches results in Redis on cache miss.
 */
export async function getEmotesByVodId(db: DBClient, tenantId: string, vodId: number): Promise<VodEmotes | null> {
  const cacheKey = CacheKeys.emotes(tenantId, vodId);

  const redis = RedisService.getActiveClient();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return (await decompressChatData(cached as unknown as Buffer)) as VodEmotes;
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
    ffz_emotes: emote.ffz_emotes as unknown as EmoteData[],
    bttv_emotes: emote.bttv_emotes as unknown as EmoteData[],
    seventv_emotes: emote.seventv_emotes as unknown as EmoteData[],
  };

  if (redis) {
    try {
      const compressed = await compressChatData(result);
      await redis.set(cacheKey, compressed as Buffer, 'EX', EMOTE_CACHE_TTL);
    } catch (err) {
      getLogger().warn({ err, cacheKey }, 'Emote cache write failed');
    }
  }

  return result;
}
