import type { PrismaClient } from '../../../generated/streamer/client.js';
import { createTwitchClient, createTwitchGqlClient } from './client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';

function getTwitchClient(tenantId: string) {
  return createTwitchClient(tenantId, () => import('./auth.js').then((m) => m.getAppAccessToken(tenantId)));
}

export async function getChapters(vodId: string, tenantId?: string): Promise<Record<string, unknown> | null> {
  const client = createTwitchGqlClient(tenantId);
  const data = await client.post<{ data?: Record<string, unknown> }>({
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

export async function getChapter(vodId: string, tenantId?: string): Promise<Record<string, unknown> | null> {
  const client = createTwitchGqlClient(tenantId);
  const data = await client.post<{ data?: { video?: Record<string, unknown> } }>({
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

export async function saveVodChapters(dbId: number, vodId: string, tenantId: string, finalDurationSeconds: number, client: PrismaClient): Promise<number> {
  const logger = createAutoLogger('twitch-chapters');
  try {
    const vod = await client.vod.findUnique({ where: { id: dbId }, select: { vod_id: true } });
    if (!vod) {
      logger.warn({ dbId, vodId }, 'VOD not found');
      return 0;
    }

    const chaptersData = await getChapters(vod.vod_id, tenantId);
    if (!chaptersData) {
      logger.warn({ vodId }, 'No chapters data available from Twitch API');
      return 0;
    }

    const chapters = Array.isArray(chaptersData) ? chaptersData : [chaptersData as unknown as Record<string, unknown>];

    if (chapters.length === 0) {
      const chapter = await getChapter(vod.vod_id, tenantId);
      if (!chapter || !chapter.game) {
        logger.warn({ vodId }, 'No game info available');
        return 0;
      }

      const game = chapter.game as Record<string, unknown>;
      const gameId = typeof game.id === 'string' ? game.id : null;
      const gameData = gameId ? await getGameData(gameId, tenantId) : null;

      await client.chapter.upsert({
        where: {
          vod_id_start: { vod_id: dbId, start: 0 },
        },
        create: {
          vod_id: dbId,
          game_id: gameId,
          name: typeof game.displayName === 'string' ? game.displayName : null,
          image: gameData && typeof gameData.box_art_url === 'string' ? gameData.box_art_url.replace('{width}x{height}', '40x53') : null,
          duration: '00:00:00',
          start: 0,
          end: finalDurationSeconds,
        },
        update: {
          game_id: gameId,
          name: typeof game.displayName === 'string' ? game.displayName : null,
          image: gameData && typeof gameData.box_art_url === 'string' ? gameData.box_art_url.replace('{width}x{height}', '40x53') : null,
          duration: '00:00:00',
          end: finalDurationSeconds,
        },
      });

      logger.info({ dbId, vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' }, 'Upserted single chapter from game info');
      return 1;
    }

    const processedStartTimes: number[] = [];
    let savedCount = 0;

    for (const ch of chapters) {
      try {
        const node = (ch.node as Record<string, unknown>) ?? {};
        const details = (node.details as Record<string, unknown>) ?? {};
        const game = details.game as Record<string, unknown> | undefined;

        const positionMs = Number(node.positionMilliseconds ?? 0);
        const durationMs = Number(node.durationMilliseconds ?? 0);

        const gameId = typeof game?.id === 'string' ? game.id : null;
        const gameName = typeof game?.displayName === 'string' ? game.displayName : null;

        let gameImage: string | null = null;
        if (gameId) {
          const gameData = await getGameData(gameId, tenantId);
          if (gameData && typeof gameData.box_art_url === 'string') {
            gameImage = gameData.box_art_url.replace('{width}x{height}', '40x53');
          }
        }

        const startSeconds = Math.floor(positionMs / 1000);
        const endSeconds = durationMs === 0 ? finalDurationSeconds - startSeconds : Math.floor(durationMs / 1000);
        const durationFormatted = toHHMMSS(startSeconds);

        await client.chapter.upsert({
          where: { vod_id_start: { vod_id: dbId, start: startSeconds } },
          create: {
            vod_id: dbId,
            game_id: gameId,
            name: gameName,
            image: gameImage,
            duration: durationFormatted,
            start: startSeconds,
            end: endSeconds,
          },
          update: {
            game_id: gameId,
            name: gameName,
            image: gameImage,
            duration: durationFormatted,
            end: endSeconds,
          },
        });

        processedStartTimes.push(startSeconds);
        savedCount++;
        logger.debug({ startSeconds, gameName }, 'Upserted chapter');
      } catch (error) {
        logger.warn({ error: extractErrorDetails(error).message }, 'Failed to save chapter');
      }
    }

    const deletedCount = await client.chapter.deleteMany({
      where: {
        vod_id: dbId,
        start: { notIn: processedStartTimes },
      },
    });

    logger.info({ dbId, vodId, saved: savedCount, deleted: deletedCount.count }, 'Saved chapters summary');

    return savedCount;
  } catch (error) {
    logger.error({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to save chapters');
    return 0;
  }
}
