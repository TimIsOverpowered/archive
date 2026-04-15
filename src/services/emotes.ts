import { logger } from '../utils/logger.js';
import { Prisma } from '../../generated/streamer/client.js';
import { Platform, PLATFORMS } from '../types/platforms.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/client.js';
import { safeRequest } from '../utils/http-client.js';

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

export async function fetchAndSaveEmotes(ctx: TenantContext, vodId: number, platform: Platform, platformId: string): Promise<void> {
  let ffzEmotes: EmoteData[] = [];
  let bttvEmotes: EmoteData[] = [];
  let sevenTvEmotes: EmoteData[] = [];

  if (platform === PLATFORMS.TWITCH && platformId) {
    const [ffzRes, bttvGlobalRes, bttvChannelRes, sevenTvRes, sevenTvGlobalRes] = await Promise.all([
      safeRequest<FFZResponse>(`https://api.frankerfacez.com/v1/room/id/${platformId}`, {}, { timeoutMs: 5000 }),
      safeRequest<BTTVGlobalResponse>('https://api.betterttv.net/3/cached/emotes/global', { emotes: [] }, { timeoutMs: 5000 }),
      safeRequest<BTTVChannelResponse>(`https://api.betterttv.net/3/cached/users/twitch/${platformId}`, { channelEmotes: [] }, { timeoutMs: 5000 }),
      safeRequest<SevenTVResponse>(`https://7tv.io/v3/users/twitch/${platformId}`, { emotes: [] }, { timeoutMs: 5000 }),
      safeRequest<SevenTVResponse>(`https://7tv.io/v3/emote-sets/global`, { emotes: [] }, { timeoutMs: 5000 }),
    ]);

    ffzEmotes = ((ffzRes as FFZResponse).channels?.[platformId]?.emotes || []).map((e) => ({ id: String(e.id), code: e.code })) || [];

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
      safeRequest<SevenTVResponse>(`https://7tv.io/v3/users/twitch/${platformId}`, { emotes: [] }, { timeoutMs: 5000 }),
      safeRequest<SevenTVResponse>(`https://7tv.io/v3/emote-sets/global`, { emotes: [] }, { timeoutMs: 5000 }),
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
      await db.emote.upsert({
        where: { vod_id: vodId },
        create: {
          vod_id: vodId,
          ffz_emotes: emoteData.ffz_emotes as EmoteData[],
          bttv_emotes: emoteData.bttv_emotes as EmoteData[],
          seventv_emotes: emoteData.seventv_emotes as EmoteData[],
        },
        update: {
          ffz_emotes: emoteData.ffz_emotes as EmoteData[],
          bttv_emotes: emoteData.bttv_emotes as EmoteData[],
          seventv_emotes: emoteData.seventv_emotes as EmoteData[],
        },
      });
    });
  } catch {
    logger.error({ vodId }, 'Failed to save emotes');
  }
}
