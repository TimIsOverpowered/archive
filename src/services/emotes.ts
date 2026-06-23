import { EmoteUpsertSchema } from '../config/schemas.js';
import { Cache, Emote } from '../constants.js';
import { withDbRetry } from '../db/streamer-client.js';
import type { DBClient } from '../db/streamer-types.js';
import { TenantContext } from '../types/context.js';
import { simpleKeys } from '../utils/cache-keys.js';
import { defaultCacheContext } from '../utils/cache.js';
import { extractErrorDetails } from '../utils/error.js';
import { safeRequest } from '../utils/http-client.js';
import { getLogger } from '../utils/logger.js';
import { publishVodUpdate } from './cache-invalidator.js';
import { invalidateEmoteCache } from './vod-cache.js';

/** Single emote from a third-party provider (FFZ, BTTV, 7TV). */
export interface EmoteData {
  id: string;
  code: string;
  flags?: number;
  width?: number;
  height?: number;
}

function buildEmote(
  id: string,
  code: string,
  opts: { width?: number | undefined; height?: number | undefined; flags?: number | undefined }
): EmoteData {
  const result: EmoteData = { id, code };
  if (opts.flags != null) result.flags = opts.flags;
  if (opts.width != null) result.width = opts.width;
  if (opts.height != null) result.height = opts.height;
  return result;
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
  width: number;
  height: number;
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
  width?: number;
  height?: number;
}

interface BTTVChannelResponse {
  channelEmotes?: BTTVEmote[];
  sharedEmotes?: BTTVEmote[];
}

interface SevenTVEmoteFile {
  name: string;
  width: number;
  height: number;
}

interface SevenTVEmoteHost {
  files: SevenTVEmoteFile[];
}

interface SevenTVEmoteData {
  host: SevenTVEmoteHost;
}

interface SevenTVEmote {
  id: string;
  name: string;
  flags: number;
  data: SevenTVEmoteData;
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
  options: FetchAndSaveEmotesOptions = {}
): Promise<void> {
  const { publishUpdate = true } = options;
  let ffzEmotes: EmoteData[] = [];
  let bttvEmotes: EmoteData[] = [];
  let sevenTvEmotes: EmoteData[] = [];

  const twitchId = ctx.config.twitch?.id;
  if (twitchId == null || twitchId === '') {
    return;
  }

  try {
    const [ffzRes, bttvChannelRes, sevenTvRes] = await Promise.all([
      safeRequest<FFZResponse>(`${Emote.FFZ_API_BASE}/${twitchId}`, {}, { timeoutMs: 5000 }),
      safeRequest<BTTVChannelResponse>(
        `${Emote.BTTV_API_BASE}/users/twitch/${twitchId}`,
        { channelEmotes: [], sharedEmotes: [] },
        { timeoutMs: 5000 }
      ),
      safeRequest<SevenTVResponse>(
        `${Emote.SEVENTV_API_BASE}/users/twitch/${twitchId}`,
        { emote_set: {} },
        { timeoutMs: 5000 }
      ),
    ]);

    const ffzSetKey = ffzRes.room?.set ?? null;
    ffzEmotes = (ffzSetKey != null ? (ffzRes.sets?.[ffzSetKey]?.emoticons ?? []) : []).map((e) =>
      buildEmote(String(e.id), e.name, { width: e.width, height: e.height })
    );

    bttvEmotes = [
      ...(bttvChannelRes.channelEmotes ?? []).map(({ id, code, width, height }) =>
        buildEmote(id, code, { width, height })
      ),
      ...(bttvChannelRes.sharedEmotes ?? []).map(({ id, code, width, height }) =>
        buildEmote(id, code, { width, height })
      ),
    ];

    sevenTvEmotes = (sevenTvRes.emote_set?.emotes ?? []).map((e) => {
      const baseFile = e.data.host.files.find((f) => f.name.startsWith('1x'));
      return buildEmote(e.id, e.name, { flags: e.flags, width: baseFile?.width, height: baseFile?.height });
    });
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
 * Compressed and cached safely using CacheContext to prevent race conditions.
 */
export async function getEmotesByVodId(db: DBClient, tenantId: string, vodId: number): Promise<VodEmotes | null> {
  const cacheKey = simpleKeys.emotes(tenantId, vodId);

  return defaultCacheContext.withCache(cacheKey, Cache.EMOTE_TTL, async () => {
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

    return {
      vodId: emote.vod_id,
      ffz_emotes: emote.ffz_emotes ?? [],
      bttv_emotes: emote.bttv_emotes ?? [],
      seventv_emotes: emote.seventv_emotes ?? [],
    };
  });
}
