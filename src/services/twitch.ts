import { getTwitchCredentials as getCreds } from '../utils/credentials.js';
import { extractErrorDetails, createErrorContext } from '../utils/error.js';
import { getTenantConfig as getConfig } from '../config/loader.js';
import { toHHMMSS } from '../utils/formatting.js';
import { PrismaClient } from '../../generated/streamer/client.js';
import { childLogger } from '../utils/logger.js';
import { stripTypename } from '../workers/chat/chat-helpers.js';
import type { InputJsonValue } from '../../generated/streamer/internal/prismaNamespace.js';
import { sendVodDownloadStarted, sendVodDownloadSuccess, sendVodDownloadFailed } from '../utils/discord-alerts.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../workers/vod/ffmpeg.js';
import { request } from '../utils/http-client.js';
import { createTwitchClient } from './twitch-client.js';
import { getAppAccessToken } from './twitch-auth.js';
import { HttpError } from '../utils/http-error.js';

export { getAppAccessToken } from './twitch-auth.js';

export interface VodData {
  id: string;
  stream_id?: string | null;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description?: string | null;
  created_at: string;
  published_at: string;
  url?: string | null;
  thumbnail_url: string;
  viewable: string;
  language: string;
  type: string;
  duration: string;
  view_count: number;
  muted_segments?: Array<{ duration: number; offset: number }> | null;
}

interface VodTokenSig {
  value: string;
  signature: string;
}

const log = childLogger({ module: 'twitch' });

function getTwitchClient(tenantId: string) {
  return createTwitchClient(tenantId, () => getAppAccessToken(tenantId));
}

export async function getVodData(vodId: string, tenantId: string): Promise<VodData> {
  const client = getTwitchClient(tenantId);
  const data = await client.helix.get<{ data: VodData[] }>(`/videos?id=${vodId}`);

  if (!data.data || data.data.length === 0) {
    throw new Error(`VOD ${vodId} not found`);
  }
  return data.data[0] as VodData;
}

export async function getVodTokenSig(vodId: string): Promise<VodTokenSig> {
  const client = getTwitchClient('gql-placeholder');

  const data = await client.gql.post<{ data: { videoPlaybackAccessToken: VodTokenSig } }>({
    operationName: 'PlaybackAccessToken',
    variables: {
      isLive: false,
      login: '',
      isVod: true,
      vodID: vodId,
      platform: 'web',
      playerBackend: 'mediaplayer',
      playerType: 'site',
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712',
      },
    },
  });

  const token = data.data.videoPlaybackAccessToken;
  if (!token) {
    throw new Error('Failed to get VOD token');
  }
  return {
    value: token.value,
    signature: token.signature,
  };
}

export async function getM3u8(vodId: string, token: string, sig: string): Promise<string> {
  const url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h265,h264&playlist_include_framerate=true&allow_spectre=true&nauthsig=${sig}&nauth=${token}`;
  return request(url, {
    responseType: 'text',
    timeoutMs: 30000,
  });
}

export async function fetchComments(vodId: string, offset = 0): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient('gql-placeholder');
  const data = await client.gql.post<{ data?: { video?: Record<string, unknown> } }>({
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: {
      videoID: vodId,
      contentOffsetSeconds: offset,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
      },
    },
  });
  return data.data?.video || null;
}

export async function fetchNextComments(vodId: string, cursor: string): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient('gql-placeholder');
  const data = await client.gql.post<{ data?: { video?: Record<string, unknown> } }>({
    operationName: 'VideoCommentsByOffsetOrCursor',
    variables: {
      videoID: vodId,
      cursor: cursor,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a',
      },
    },
  });
  return data.data?.video || null;
}

export async function getChapters(vodId: string): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient('gql-placeholder');
  const data = await client.gql.post<{ data?: Record<string, unknown> }>({
    operationName: 'VideoPreviewCard__VideoMoments',
    variables: {
      videoId: vodId,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '7399051b2d46f528d5f0eedf8b0db8d485bb1bb4c0a2c6707be6f1290cdcb31a',
      },
    },
  });
  return data?.data || null;
}

export async function getChapter(vodId: string): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient('gql-placeholder');
  const data = await client.gql.post<{ data?: { video?: Record<string, unknown> } }>({
    operationName: 'NielsenContentMetadata',
    variables: {
      isCollectionContent: false,
      isLiveContent: false,
      isVODContent: true,
      collectionID: '',
      login: '',
      vodID: vodId,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '2dbf505ee929438369e68e72319d1106bb3c142e295332fac157c90638968586',
      },
    },
  });
  return data.data?.video || null;
}

export async function getGameData(gameId: string, tenantId: string): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient(tenantId);
  const data = await client.helix.get<{ data: Record<string, unknown>[] }>(`/games?id=${gameId}`);

  if (!data.data || data.data.length === 0) {
    return null;
  }
  return data.data[0];
}

export async function getChannelBadges(tenantId: string): Promise<Record<string, unknown> | null> {
  const creds = getCreds(tenantId);
  const config = getConfig(tenantId);
  if (!creds?.clientId || !config?.twitch?.id) {
    log.warn(`Twitch credentials not configured for streamer ${tenantId}`);
    return null;
  }

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get<{ data?: Record<string, unknown> }>(`/chat/badges?broadcaster_id=${config.twitch.id}`);

    const badgesData = data?.data || null;
    if (!badgesData) {
      log.debug(`No channel badges found for Twitch user ${config.twitch.id}`);
    }
    return badgesData as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      if (error.statusCode === 404) {
        log.debug({ tenantId }, 'Channel badges not found (404)');
      } else if (error.statusCode >= 500) {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Twitch API unstable, skipping badges');
      } else {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Failed to fetch channel badges');
      }
      return null;
    }

    const { message } = extractErrorDetails(error);
    log.error({ tenantId, error: message }, 'Failed to fetch channel badges');
    return null;
  }
}

export async function getGlobalBadges(tenantId: string): Promise<Record<string, unknown> | null> {
  const creds = getCreds(tenantId);
  if (!creds?.clientId) return null;

  try {
    const client = getTwitchClient(tenantId);
    const data = await client.helix.get<{ data?: Record<string, unknown> }>('/chat/badges/global');
    return (data?.data || null) as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      if (error.statusCode === 404) {
        log.debug({ tenantId }, 'Global badges not found (404)');
      } else if (error.statusCode >= 500) {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Twitch API unstable, skipping badges');
      } else {
        log.warn({ tenantId, statusCode: error.statusCode }, 'Failed to fetch global badges');
      }
      return null;
    }

    const { message } = extractErrorDetails(error);
    log.error({ tenantId, error: message }, 'Failed to fetch global badges');
    return null;
  }
}

export interface TwitchEmoteFragment {
  __typename?: 'EmoteFragment';
  id: string;
  text: string | null;
}

export interface TwitchBadgeSetItem {
  __typename?: 'BadgeSetItem';
  badgeVersionId: string;
  setID: string;
}

export type TwitchUserBadgesArray = TwitchBadgeSetItem[];

export interface TwitchCommentMessageNode {
  __typename?: 'CommentMessageNode';
  emote: boolean | null;
  fragments: TwitchEmoteFragment[] | null;
  userBadges: TwitchUserBadgesArray | null;
  userColor: string | null;
}

export interface TwitchCommenterProfile {
  __typename?: 'UserProfile';
  displayName: string | null;
}

export interface TwitchChatMessageNode {
  __typename?: 'ChatMessageNode';
  id: string;
  commenter: TwitchCommenterProfile | null;
  contentOffsetSeconds: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  message: TwitchCommentMessageNode | null;
}

export interface TwitchChatEdge {
  __typename?: 'ChatEdge';
  cursor: string | null;
  node: TwitchChatMessageNode | null;
}

export interface TwitchCommentsConnection {
  __typename?: 'VideoCommentsConnection';
  edges: TwitchChatEdge[] | null;
}

export interface TwitchVideoCommentResponse {
  __typename?: 'VideoObject';
  id: string | null;
  comments: TwitchCommentsConnection | null;
}

export function extractMessageData(node: TwitchChatMessageNode | null | undefined): { message: InputJsonValue; userBadges?: InputJsonValue | undefined } {
  if (!node || !node.message) {
    return { message: { content: '', fragments: [] }, userBadges: undefined };
  }

  const rawFragments = node.message.fragments || [];
  const cleanFragments = stripTypename(rawFragments);
  const badgesRaw = node.message.userBadges ?? null;

  return {
    message: {
      content: (Array.isArray(cleanFragments) ? cleanFragments : [])
        .map((f: unknown) => {
          if (typeof f !== 'object' || f === null) return '';
          const text = (f as Record<string, unknown>).text;
          return String(text ?? '');
        })
        .join(''),
      fragments: Array.isArray(cleanFragments) ? cleanFragments.map((frag) => ({ ...frag })) : [],
    },
    userBadges: badgesRaw && typeof stripTypename(badgesRaw) === 'object' ? (stripTypename(badgesRaw) as InputJsonValue) : undefined,
  };
}

export async function downloadVodAsMp4(vodId: string, tenantId: string): Promise<string | null> {
  const config = getConfig(tenantId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${tenantId}`);
  }

  let messageId: string | null = null;

  try {
    const tokenSig = await getVodTokenSig(vodId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    const m3u8Url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const { getVodFilePath } = await import('../utils/path.js');

    const vodPath = getVodFilePath({ tenantId, vodId });

    const streamerName = config.displayName || tenantId;
    messageId = await sendVodDownloadStarted('twitch', tenantId, vodId, streamerName);

    const m3u8Content = await request(m3u8Url, {
      responseType: 'text',
      timeoutMs: 30000,
    });
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    await convertHlsToMp4(m3u8Url, vodPath, { vodId, isFmp4 });

    log.info(`Downloaded ${vodId}.mp4`);

    await sendVodDownloadSuccess(messageId!, 'twitch', vodId, vodPath, streamerName);

    return vodPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`ffmpeg error occurred: ${errorMsg}`);

    await sendVodDownloadFailed(messageId!, 'twitch', vodId, errorMsg, tenantId);

    throw error;
  }
}

export async function saveVodChapters(dbId: number, vodId: string, tenantId: string, finalDurationSeconds: number, client: PrismaClient): Promise<void> {
  try {
    const vod = await client.vod.findUnique({ where: { id: dbId }, select: { vod_id: true } });
    if (!vod) {
      log.warn({ dbId, vodId }, 'VOD not found');
      return;
    }

    await client.chapter.deleteMany({
      where: { vod_id: dbId },
    });

    const chaptersData = await getChapters(vod.vod_id);
    if (!chaptersData) {
      log.warn({ vodId }, 'No chapters data available from Twitch API');
      return;
    }

    const chapters = Array.isArray(chaptersData) ? chaptersData : [chaptersData as unknown as Record<string, unknown>];

    if (chapters.length === 0) {
      const chapter = await getChapter(vod.vod_id);
      if (!chapter || !chapter.game) {
        log.warn({ vodId }, 'No game info available');
        return;
      }

      const game = chapter.game as Record<string, unknown>;
      const gameId = typeof game.id === 'string' ? game.id : null;
      const gameData = gameId ? await getGameData(gameId, tenantId) : null;

      await client.chapter.create({
        data: {
          vod_id: dbId,
          game_id: gameId,
          name: typeof game.displayName === 'string' ? game.displayName : null,
          image: gameData && typeof gameData.box_art_url === 'string' ? gameData.box_art_url.replace('{width}x{height}', '40x53') : null,
          duration: '00:00:00',
          start: 0,
          end: finalDurationSeconds,
        },
      });

      log.info({ dbId, vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' }, 'Created single chapter from game info');
      return;
    }

    const chaptersToCreate = chapters.map((ch: Record<string, unknown>) => {
      const node = (ch.node as Record<string, unknown>) ?? {};
      const details = (node.details as Record<string, unknown>) ?? {};
      const game = details.game as Record<string, unknown> | undefined;

      const positionMs = Number(node.positionMilliseconds ?? 0);
      const durationMs = Number(node.durationMilliseconds ?? 0);

      const gameId = typeof game?.id === 'string' ? (game.id as string) : null;
      const gameName = typeof game?.displayName === 'string' ? (game.displayName as string) : null;
      const gameImage = typeof game?.boxArtURL === 'string' ? (game.boxArtURL as string) : null;

      return {
        vod_id: dbId,
        game_id: gameId,
        name: gameName,
        image: gameImage,
        duration: toHHMMSS(Math.floor(positionMs / 1000)),
        start: Math.floor(positionMs / 1000),
        end: durationMs === 0 ? finalDurationSeconds - Math.floor(positionMs / 1000) : Math.floor(durationMs / 1000),
      };
    });

    await client.chapter.createMany({
      data: chaptersToCreate,
    });

    log.info({ dbId, vodId, chapterCount: chaptersToCreate.length }, 'Saved all chapters');
  } catch (error) {
    log.error(createErrorContext(error, { dbId, vodId }), 'Failed to save chapters');
  }
}
