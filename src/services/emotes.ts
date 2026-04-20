import { getLogger } from '../utils/logger.js';
import { Prisma, PrismaClient } from '../../generated/streamer/client.js';
import { Platform, PLATFORMS } from '../types/platforms.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/client.js';
import { safeRequest } from '../utils/http-client.js';
import { RedisService } from '../utils/redis-service.js';
import { getDisableRedisCache } from '../config/env-accessors.js';
import { compressChatData, decompressChatData } from '../utils/compression.js';
import { EMOTE_CACHE_TTL, FFZ_API_BASE, BTTV_API_BASE, SEVENTV_API_BASE } from '../constants.js';
import { EmoteUpsertSchema } from '../config/schemas.js';
import { invalidateEmoteCache } from './vod-cache.js';
import { publishVodUpdate } from './cache-invalidator.js';

export interface EmoteData extends Prisma.JsonObject {
  id: string;
  code: string;
  flags?: number;
}

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
      await db.emote.upsert({
        where: { vod_id: vodId },
        create: {
          vod_id: validatedEmotes.vod_id,
          ffz_emotes: validatedEmotes.ffz_emotes as EmoteData[],
          bttv_emotes: validatedEmotes.bttv_emotes as EmoteData[],
          seventv_emotes: validatedEmotes.seventv_emotes as EmoteData[],
        },
        update: {
          ffz_emotes: validatedEmotes.ffz_emotes as EmoteData[],
          bttv_emotes: validatedEmotes.bttv_emotes as EmoteData[],
          seventv_emotes: validatedEmotes.seventv_emotes as EmoteData[],
        },
      });

      await invalidateEmoteCache(ctx.tenantId, vodId);
      await publishVodUpdate(ctx.tenantId, vodId);
    });
  } catch {
    getLogger().error({ vodId }, 'Failed to save emotes');
  }
}

export async function getEmotesByVodId(
  client: PrismaClient,
  tenantId: string,
  vodId: number
): Promise<VodEmotes | null> {
  const cacheKey = `emotes:${tenantId}:${vodId}`;

  const redis = RedisService.instance?.getClient() ?? null;
  if (redis && !getDisableRedisCache()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return (await decompressChatData(cached as unknown as Buffer)) as VodEmotes;
      }
    } catch (err) {
      getLogger().warn({ err, cacheKey }, 'Emote cache read failed, falling back to DB');
    }
  }

  const emote = await client.emote.findUnique({
    where: { vod_id: vodId },
    include: {
      vod: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!emote || !emote.vod) {
    return null;
  }

  const result: VodEmotes = {
    vodId: emote.vod_id,
    ffz_emotes: emote.ffz_emotes as EmoteData[],
    bttv_emotes: emote.bttv_emotes as EmoteData[],
    seventv_emotes: emote.seventv_emotes as EmoteData[],
  };

  if (redis && !getDisableRedisCache()) {
    try {
      const compressed = await compressChatData(result);
      await redis.set(cacheKey, compressed as Buffer, 'EX', EMOTE_CACHE_TTL);
    } catch (err) {
      getLogger().warn({ err, cacheKey }, 'Emote cache write failed');
    }
  }

  return result;
}
