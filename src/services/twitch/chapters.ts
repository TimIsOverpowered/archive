import { getTwitchClient } from './auth.js';
import { createTwitchGqlClient, BACKUP_TWITCH_GQL_CLIENT_ID } from './client.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { TenantContext } from '../../types/context.js';
import { withDbRetry } from '../../db/client.js';

export async function getChapters(vodId: string, tenantId?: string): Promise<unknown[] | null> {
  const client = createTwitchGqlClient(tenantId, BACKUP_TWITCH_GQL_CLIENT_ID);
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
  const video = (data?.data as Record<string, unknown> | undefined)?.video as Record<string, unknown> | undefined;
  const moments = video?.moments as Record<string, unknown> | undefined;
  return moments?.edges as unknown[] | null;
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
  return data?.data?.video || null;
}

export async function getGameData(gameId: string, tenantId: string): Promise<Record<string, unknown> | null> {
  const client = getTwitchClient(tenantId);
  const data = await client.helix.get<{ data: Record<string, unknown>[] }>(`/games?id=${gameId}`);

  if (!data.data || data.data.length === 0) {
    return null;
  }
  return data.data[0];
}

export async function saveVodChapters(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  finalDurationSeconds: number
): Promise<number> {
  const { tenantId } = ctx;
  const logger = createAutoLogger('twitch-chapters');
  try {
    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      await db.chapter.deleteMany({
        where: { vod_id: dbId },
      });

      const chapters = await getChapters(vodId, tenantId);
      if (!chapters) {
        logger.warn({ vodId }, 'No chapters data available from Twitch API');
        return;
      }

      if (chapters.length === 0) {
        const chapter = await getChapter(vodId, tenantId);
        if (!chapter || !chapter.game) {
          logger.warn({ vodId }, 'No game info available');
          return;
        }

        const game = chapter.game as Record<string, unknown>;
        const gameId = typeof game.id === 'string' ? game.id : null;
        const gameData = gameId ? await getGameData(gameId, tenantId) : null;

        await db.chapter.create({
          data: {
            vod_id: dbId,
            game_id: gameId,
            name: typeof game.displayName === 'string' ? game.displayName : null,
            image:
              gameData && typeof gameData.box_art_url === 'string'
                ? gameData.box_art_url.replace('{width}x{height}', '40x53')
                : null,
            duration: '00:00:00',
            start: 0,
            end: finalDurationSeconds,
          },
        });

        logger.info(
          { dbId, vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' },
          'Created single chapter from game info'
        );
        return;
      } else if (chapters.length > 0) {
        const chaptersToCreate = [];

        for (const ch of chapters) {
          try {
            const chapterObj = ch as Record<string, unknown>;
            const node = (chapterObj.node as Record<string, unknown>) ?? {};
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

            chaptersToCreate.push({
              vod_id: dbId,
              game_id: gameId,
              name: gameName,
              image: gameImage,
              duration: durationFormatted,
              start: startSeconds,
              end: endSeconds,
            });
          } catch (error) {
            logger.warn({ error: extractErrorDetails(error).message }, 'Failed to process chapter');
          }
        }

        if (chaptersToCreate.length > 0) {
          await db.chapter.createMany({
            data: chaptersToCreate,
          });

          logger.info({ dbId, vodId, chapterCount: chaptersToCreate.length }, 'Saved all chapters');
        }
      }
    });
    return 0;
  } catch (error) {
    logger.error({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to save chapters');
    return 0;
  }
}
