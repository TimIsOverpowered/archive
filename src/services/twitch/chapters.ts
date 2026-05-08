import { LRUCache } from 'lru-cache';
import { ChapterCreateSchema } from '../../config/schemas.js';
import { Twitch } from '../../constants.js';
import { withDbRetry } from '../../db/streamer-client.js';
import { TenantContext } from '../../types/context.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { publishVodUpdate } from '../cache-invalidator.js';
import { getTwitchClient } from './auth.js';
import { createTwitchGqlClient } from './client.js';

const gameDataCache = new LRUCache<string, Record<string, unknown>>({
  max: 1000,
  ttl: 24 * 60 * 60 * 1000,
  allowStale: false,
});

export async function getChapters(vodId: string, tenantId?: string): Promise<unknown[] | null> {
  const client = createTwitchGqlClient(tenantId, Twitch.BACKUP_GQL_CLIENT_ID);
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
  const video = data?.data?.video as Record<string, unknown> | undefined;
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
  return data?.data?.video ?? null;
}

export async function getGameData(
  gameId: string,
  logContext?: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const cached = gameDataCache.get(gameId);
  if (cached !== undefined) {
    return cached;
  }

  const client = getTwitchClient();
  const data = await client.helix.get<{ data: Record<string, unknown>[] }>(`/games?id=${gameId}`, logContext);

  if (data.data == null || data.data.length === 0) {
    return null;
  }

  const result = data.data[0];
  if (result == null) return null;
  gameDataCache.set(gameId, result);
  return result;
}

export async function saveVodChapters(
  ctx: Omit<TenantContext, 'db'>,
  dbId: number,
  vodId: string,
  finalDurationSeconds: number
): Promise<number> {
  const { tenantId } = ctx;
  const logger = createAutoLogger('twitch-chapters');
  try {
    return await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      await db.deleteFrom('chapters').where('vod_id', '=', dbId).execute();

      await publishVodUpdate(tenantId, dbId);

      const chapters = await getChapters(vodId, tenantId);
      if (!chapters) {
        logger.warn({ vodId }, 'No chapters data available from Twitch API');
        return 0;
      }

      if (chapters.length === 0) {
        const chapter = await getChapter(vodId, tenantId);
        if (chapter == null || chapter.game == null) {
          logger.warn({ vodId }, 'No game info available');
          return 0;
        }

        const game = chapter.game as Record<string, unknown>;
        const gameId = typeof game.id === 'string' ? game.id : null;
        const gameData = gameId != null ? await getGameData(gameId, { tenantId }) : null;

        const validatedChapter = ChapterCreateSchema.parse({
          vod_id: dbId,
          start: 0,
          duration: finalDurationSeconds,
          end: finalDurationSeconds,
          title: typeof game.displayName === 'string' ? game.displayName : null,
          game_id: gameId,
        });
        await db
          .insertInto('chapters')
          .values({
            vod_id: validatedChapter.vod_id,
            game_id: validatedChapter.game_id,
            name: validatedChapter.title,
            image: gameData && typeof gameData.box_art_url === 'string' ? gameData.box_art_url : null,
            start: validatedChapter.start,
            duration: validatedChapter.duration,
            end: validatedChapter.end,
          })
          .execute();

        await publishVodUpdate(tenantId, dbId);

        logger.info(
          { dbId, vodId, game: typeof game.displayName === 'string' ? game.displayName : 'unknown' },
          'Created single chapter from game info'
        );
        return 1;
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
            if (gameId != null && gameId !== '') {
              const gameData = await getGameData(gameId, { tenantId });
              if (gameData != null && typeof gameData.box_art_url === 'string') {
                gameImage = gameData.box_art_url;
              }
            }

            const startSeconds = Math.floor(positionMs / 1000);
            const durationSeconds =
              durationMs === 0 ? finalDurationSeconds - startSeconds : Math.floor(durationMs / 1000);

            const validatedChapter = ChapterCreateSchema.parse({
              vod_id: dbId,
              start: startSeconds,
              duration: durationSeconds,
              end: startSeconds + durationSeconds,
              title: gameName,
              game_id: gameId,
            });

            chaptersToCreate.push({
              vod_id: validatedChapter.vod_id,
              game_id: validatedChapter.game_id,
              name: validatedChapter.title,
              image: gameImage,
              start: validatedChapter.start,
              duration: validatedChapter.duration,
              end: validatedChapter.end,
            });
          } catch (error) {
            logger.warn({ error: extractErrorDetails(error).message }, 'Failed to process chapter');
          }
        }

        if (chaptersToCreate.length > 0) {
          for (const ch of chaptersToCreate) {
            await db.insertInto('chapters').values(ch).execute();
          }

          await publishVodUpdate(tenantId, dbId);

          logger.info({ dbId, vodId, chapterCount: chaptersToCreate.length }, 'Saved all chapters');
          return chaptersToCreate.length;
        }
        return 0;
      }
      return 0;
    });
  } catch (error) {
    logger.error({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to save chapters');
    return 0;
  }
}
