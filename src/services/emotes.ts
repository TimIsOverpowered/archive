import { logger } from '../utils/logger.js';
import { Prisma } from '../../generated/streamer/client.js';
import { Platform, PLATFORMS } from '../types/platforms.js';

export interface EmoteData extends Prisma.JsonObject {
  id: string;
  code: string;
  flags?: string[];
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

interface SevenTVUserResponse {
  emotes?: Array<{
    id: string;
    name: string;
    flags?: string[];
  }>;
}

export async function fetchAndSaveEmotes(tenantId: string, vodId: number, platform: Platform, platformId?: string): Promise<void> {
  let ffzEmotes: EmoteData[] = [];
  let bttvEmotes: EmoteData[] = [];
  let sevenTvEmotes: EmoteData[] = [];

  if (platform === PLATFORMS.TWITCH && platformId) {
    try {
      const [ffzRes, bttvGlobalRes, bttvChannelRes, sevenTvRes] = await Promise.all([
        fetch(`https://api.frankerfacez.com/v1/room/id/${platformId}`, { signal: AbortSignal.timeout(5000) })
          .then((r) => (r.ok ? (r.json() as Promise<FFZResponse>) : {}))
          .catch(() => ({})),

        fetch('https://api.betterttv.net/3/cached/emotes/global', { signal: AbortSignal.timeout(5000) })
          .then((r) => (r.ok ? (r.json() as Promise<BTTVGlobalResponse>) : { emotes: [] }))
          .catch(() => ({ emotes: [] })),

        fetch(`https://api.betterttv.net/3/cached/users/twitch/${platformId}`, { signal: AbortSignal.timeout(5000) })
          .then((r) => (r.ok ? (r.json() as Promise<BTTVChannelResponse>) : {}))
          .catch(() => ({ channelEmotes: [] })),

        fetch(`https://7tv.io/v3/users/twitch/${platformId}`, { signal: AbortSignal.timeout(5000) })
          .then((r) => (r.ok ? (r.json() as Promise<SevenTVUserResponse>) : {}))
          .catch(() => ({ emotes: [] })),
      ]);

      ffzEmotes = ((ffzRes as FFZResponse).channels?.[platformId]?.emotes || []).map((e) => ({ id: String(e.id), code: e.code })) || [];

      bttvEmotes = [
        ...(bttvGlobalRes.emotes || []).map(({ id, code }) => ({ id, code })),
        ...(((bttvChannelRes as BTTVChannelResponse).channelEmotes || [])?.map(({ id, code }) => ({ id, code })) || []),
      ];

      sevenTvEmotes = ((sevenTvRes as SevenTVUserResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags }));
    } catch {
      logger.error({ platform, platformId }, 'Failed to fetch Twitch emotes');
    }
  } else if (platform === PLATFORMS.KICK && platformId) {
    try {
      const sevenTvRes = await fetch(`https://7tv.io/v3/users/kick/${platformId}`, { signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? (r.json() as Promise<SevenTVUserResponse>) : {}))
        .catch(() => ({ emotes: [] }));

      ffzEmotes = [];
      bttvEmotes = [];
      sevenTvEmotes = ((sevenTvRes as SevenTVUserResponse)?.emotes || []).map((e) => ({ id: e.id, code: e.name, flags: e.flags }));
    } catch {
      logger.error({ platform, platformId }, 'Failed to fetch Kick emotes');
    }
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
    const { getClient } = await import('../db/client');
    const db = getClient(tenantId);

    if (!db) {
      logger.error({ tenantId }, 'Database client not available for streamer');
      return;
    }

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
  } catch {
    logger.error({ vodId }, 'Failed to save emotes');
  }
}
