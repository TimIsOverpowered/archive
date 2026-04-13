import type { PrismaClient } from '../../../generated/streamer/client.js';
import { createTwitchClient } from './client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';

function getTwitchClient(tenantId: string) {
  return createTwitchClient(tenantId, () => import('./auth.js').then((m) => m.getAppAccessToken(tenantId)));
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

export async function saveVodChapters(dbId: number, vodId: string, tenantId: string, finalDurationSeconds: number, client: PrismaClient): Promise<void> {
  const logger = createAutoLogger('twitch-chapters');
  try {
    const vod = await client.vod.findUnique({ where: { id: dbId }, select: { vod_id: true } });
    if (!vod) {
      logger.warn({ dbId, vodId }, 'VOD not found');
      return;
    }

    await client.chapter.deleteMany({
      where: { vod_id: dbId },
    });

    const chaptersData = await getChapters(vod.vod_id);
    if (!chaptersData) {
      logger.warn({ vodId }, 'No chapters data available from Twitch API');
      return;
    }

    const chapters = Array.isArray(chaptersData) ? chaptersData : [chaptersData as unknown as Record<string, unknown>];

    if (chapters.length === 0) {
      const chapter = await getChapter(vod.vod_id);
      if (!chapter || !chapter.game) {
        logger.warn({ vodId }, 'No game info available');
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

      logger.info({ dbId, vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' }, 'Created single chapter from game info');
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

    logger.info({ dbId, vodId, chapterCount: chaptersToCreate.length }, 'Saved all chapters');
  } catch (error) {
    logger.error({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to save chapters');
  }
}
