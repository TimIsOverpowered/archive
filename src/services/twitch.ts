import { getTwitchCredentials as getCreds } from '../utils/credentials.js';
import { extractErrorDetails, silentFail } from '../utils/error.js';
import { getStreamerConfig as getConfig } from '../config/loader.js';
import { toHHMMSS } from '../utils/formatting.js';
import { PrismaClient } from '../../generated/streamer/client.js';
import { childLogger } from '../utils/logger.js';

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
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const log = childLogger({ module: 'twitch' });

export async function getAppAccessToken(streamerId: string): Promise<string> {
  const creds = getCreds(streamerId);
  if (!creds) {
    throw new Error('Twitch credentials not configured');
  }
  const cached = tokenCache.get(streamerId);
  if (cached && cached.expiresAt > Date.now() + 24 * 60 * 60 * 1000) {
    return cached.token;
  }
  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.append('client_id', creds.clientId);
  url.searchParams.append('client_secret', creds.clientSecret);
  url.searchParams.append('grant_type', 'client_credentials');
  const response = await fetch(url.toString(), {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch token failed with status ${response.status}`);
  const data = await response.json();
  const { access_token, expires_in } = data;
  tokenCache.set(streamerId, {
    token: access_token,
    expiresAt: Date.now() + expires_in * 1000,
  });
  return access_token;
}
export async function getVodData(vodId: string, streamerId: string): Promise<VodData> {
  const accessToken = await getAppAccessToken(streamerId);
  const creds = getCreds(streamerId)!;
  const url = new URL('https://api.twitch.tv/helix/videos');
  url.searchParams.append('id', vodId);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': creds.clientId,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch API failed with status ${response.status}`);
  const data = await response.json();
  if (!data.data || data.data.length === 0) {
    throw new Error(`VOD ${vodId} not found`);
  }
  return data.data[0] as VodData;
}
export async function getVodTokenSig(vodId: string): Promise<VodTokenSig> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',

      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch token sig failed with status ${response.status}`);
  const data = await response.json();
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
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Twitch M3U8 failed with status ${response.status}`);
  return response.text();
}
export async function fetchComments(vodId: string, offset = 0): Promise<Record<string, unknown> | null> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',

      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch comments failed with status ${response.status}`);
  const data = await response.json();
  return data.data?.video || null;
}
export async function fetchNextComments(vodId: string, cursor: string): Promise<Record<string, unknown> | null> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Client-Id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',

      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch next comments failed with status ${response.status}`);
  const data = await response.json();
  return data.data?.video || null;
}
export async function getChapters(vodId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Client-Id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',

      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch chapters failed with status ${response.status}`);
  const data = await response.json();
  return data?.data || null;
}
export async function getChapter(vodId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',

      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch chapter failed with status ${response.status}`);
  const data = await response.json();
  return data.data?.video || null;
}
export async function getGameData(gameId: string, streamerId: string): Promise<Record<string, unknown> | null> {
  const accessToken = await getAppAccessToken(streamerId);
  const creds = getCreds(streamerId)!;
  const url = new URL('https://api.twitch.tv/helix/games');
  url.searchParams.append('id', gameId);
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': creds.clientId,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twitch game data failed with status ${response.status}`);
  const data = await response.json();
  if (!data.data || data.data.length === 0) {
    return null;
  }
  return data.data[0];
}
export async function getChannelBadges(streamerId: string): Promise<Record<string, unknown> | null> {
  const creds = getCreds(streamerId);
  const config = getConfig(streamerId);
  if (!creds?.clientId || !config?.twitch?.id) {
    log.warn(`Twitch credentials not configured for streamer ${streamerId}`);
    return null;
  }
  try {
    const accessToken = await getAppAccessToken(streamerId);
    if (!accessToken) throw new Error('Twitch OAuth access token unavailable');
    const url = new URL(`https://api.twitch.tv/helix/chat/badges`);
    url.searchParams.append('broadcaster_id', config.twitch.id.toString());
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': creds.clientId,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Twitch badges failed with status ${response.status}`);
    const data = await response.json();
    const badgesData = data?.data || null;
    if (!badgesData) {
      log.warn(`No channel badges found for Twitch user ${config.twitch.id}`);
    }
    return badgesData as Record<string, unknown>;
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    log.error(`Failed to fetch channel badges for ${streamerId}: ${message}`);
    return null;
  }
}

export async function getGlobalBadges(streamerId: string): Promise<Record<string, unknown> | null> {
  const creds = getCreds(streamerId);
  if (!creds?.clientId) return null;
  try {
    const accessToken = await getAppAccessToken(streamerId);
    if (!accessToken) throw new Error('Twitch OAuth access token unavailable');
    const response = await fetch('https://api.twitch.tv/helix/chat/badges/global', {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': creds.clientId },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Twitch global badges failed with status ${response.status}`);
    const data = await response.json();
    return (data?.data || null) as Record<string, unknown>;
  } catch (error: unknown) {
    const { message } = extractErrorDetails(error);
    log.error(`Failed to fetch global badges for ${streamerId}: ${message}`);
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

import { sendRichAlert, updateDiscordEmbed, isAlertsEnabled } from '../utils/discord-alerts.js';
import { convertHlsToMp4, detectFmp4FromPlaylist } from '../utils/ffmpeg.js';

/**
 * Download Twitch VOD directly to MP4 using ffmpeg HLS streaming (reference: vod.js line 1209-1237)
 */
export async function downloadVodAsMp4(vodId: string, streamerId: string): Promise<string | null> {
  const config = getConfig(streamerId);

  if (!config?.settings.vodPath) {
    throw new Error(`No vodPath configured for streamer ${streamerId}`);
  }

  let messageId: string | null = null;

  try {
    // Get token/sig for authentication (reference line 1209-1214)
    const tokenSig = await getVodTokenSig(vodId);

    if (!tokenSig) {
      throw new Error(`Failed to get token/sig for ${vodId}`);
    }

    // Build authenticated HLS URL (reference line 136-205 + hls-downloader.ts pattern with allow_source=true)
    const m3u8Url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?allow_source=true&player=mediaplayer&include_unavailable=true&supported_codecs=av1,h264,hevc&playlist_include_framerate=true&nauthsig=${tokenSig.signature}&nauth=${tokenSig.value}`;

    const vodPath = `${config.settings.vodPath}/${vodId}.mp4`;

    // Send Discord "Download Started" alert
    if (isAlertsEnabled()) {
      silentFail(async () => {
        const streamerName = config.displayName || streamerId;
        messageId = await sendRichAlert({
          title: '📥 Twitch VOD Download Started',
          description: `${vodId} download in progress for ${streamerName}`,
          status: 'warning',
          fields: [
            { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
            { name: 'Streamer', value: `\`${streamerName}\`` },
          ],
          timestamp: new Date().toISOString(),
        });
      });
    }

    // Fetch m3u8 playlist and detect fMP4 format (Twitch can use both .ts or fMP4)
    const response = await fetch(m3u8Url);

    if (!response.ok) {
      throw new Error(`Failed to fetch Twitch HLS playlist: ${response.status} ${response.statusText}`);
    }

    const m3u8Content = await response.text();
    const isFmp4 = detectFmp4FromPlaylist(m3u8Content);

    // Download directly to MP4 using ffmpeg HLS streaming (reference line 1209-1237, consolidated in ffmpeg.ts)
    await convertHlsToMp4(m3u8Url, vodPath, { vodId, isFmp4 });

    log.info(`Downloaded ${vodId}.mp4`); // Reference pattern line 1207-209

    // Success alert
    if (isAlertsEnabled() && messageId) {
      silentFail(async () => {
        const streamerName = config.displayName || streamerId;

        await updateDiscordEmbed(messageId!, {
          title: '✅ Twitch VOD Download Complete!',
          description: `${vodId} successfully downloaded and converted to MP4 for ${streamerName}`,
          status: 'success',
          fields: [
            { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
            { name: 'Output Path', value: vodPath, inline: false },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      });
    }

    return vodPath;
  } catch (error) {
    const details = extractErrorDetails(error);
    const errorMsg = details.message.substring(0, 500);

    log.error(`\nffmpeg error occurred: ${errorMsg}`); // Reference pattern line 1209-214

    // Failure alert
    if (isAlertsEnabled() && messageId) {
      silentFail(async () => {
        await updateDiscordEmbed(messageId!, {
          title: '❌ Twitch VOD Download Failed',
          description: `${vodId} download failed for ${streamerId}`,
          status: 'error',
          fields: [
            { name: 'VOD ID', value: `\`${vodId}\``, inline: false },
            { name: 'Error', value: errorMsg, inline: false },
          ],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      });
    }

    throw error;
  }
}

export async function saveVodChapters(vodId: string, streamerId: string, finalDurationSeconds: number, client: PrismaClient): Promise<void> {
  try {
    await client.chapter.deleteMany({
      where: { vod_id: vodId },
    });

    const chaptersData = await getChapters(vodId);
    if (!chaptersData) {
      log.warn({ vodId }, 'No chapters data available from Twitch API');
      return;
    }

    const chapters = Array.isArray(chaptersData) ? chaptersData : [chaptersData as unknown as Record<string, unknown>];

    if (chapters.length === 0) {
      const chapter = await getChapter(vodId);
      if (!chapter || !chapter.game) {
        log.warn({ vodId }, 'No game info available');
        return;
      }

      const game = chapter.game as Record<string, unknown>;
      const gameId = typeof game.id === 'string' ? game.id : null;
      const gameData = gameId ? await getGameData(gameId, streamerId) : null;

      await client.chapter.create({
        data: {
          vod_id: vodId,
          game_id: gameId,
          name: typeof game.displayName === 'string' ? game.displayName : null,
          image: gameData && typeof gameData.box_art_url === 'string' ? gameData.box_art_url.replace('{width}x{height}', '40x53') : null,
          duration: '00:00:00',
          start: 0,
          end: finalDurationSeconds,
        },
      });

      log.info({ vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' }, 'Created single chapter from game info');
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
        vod_id: vodId,
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

    log.info({ vodId, chapterCount: chaptersToCreate.length }, 'Saved all chapters');
  } catch (error) {
    log.error({ vodId, error: extractErrorDetails(error).message }, 'Failed to save chapters');
  }
}
