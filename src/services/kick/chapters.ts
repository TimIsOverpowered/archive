import dayjs from 'dayjs';
import { ChapterCreateSchema, ChapterUpdateSchema } from '../../config/schemas.js';
import { withDbRetry } from '../../db/streamer-client.js';
import { TenantContext } from '../../types/context.js';
import { extractErrorDetails, createErrorContext } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { publishVodUpdate } from '../cache-invalidator.js';
import { getKickCategoryInfo } from './category.js';
import { getKickStreamStatus } from './live.js';

const log = childLogger({ module: 'kick-chapters' });

export async function updateChapterDuringDownload(ctx: TenantContext, dbId: number, vodId: string): Promise<void> {
  try {
    const { config } = ctx;
    const username = config.kick?.username;
    if (username == null || username === '') {
      log.warn({ dbId, vodId }, 'Kick username not configured');
      return;
    }

    const streamData = await getKickStreamStatus(username);
    if (!streamData || !streamData.category) {
      log.debug({ dbId, vodId }, 'No active stream or category data');
      return;
    }

    const { category, created_at } = streamData;
    const currentTimeSeconds = dayjs().diff(created_at, 'second');

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const lastChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (lastChapter && lastChapter.game_id === String(category.id)) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db.updateTable('chapters').set({ end: currentTimeSeconds }).where('id', '=', lastChapter.id).execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug({ vodId, chapterId: lastChapter.id, currentTime: currentTimeSeconds }, 'Updated chapter end time');
        return;
      }

      if (lastChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db.updateTable('chapters').set({ end: currentTimeSeconds }).where('id', '=', lastChapter.id).execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug({ vodId, chapterId: lastChapter.id }, 'Closed previous chapter');
      }

      let bannerImage: string | null = null;
      if (category.slug != null && category.slug !== '') {
        try {
          const categoryInfo = await getKickCategoryInfo(category.slug);
          if (categoryInfo && typeof categoryInfo.banner === 'object' && categoryInfo.banner !== null) {
            bannerImage = (categoryInfo.banner as Record<string, unknown>).src as string | null;
          }
        } catch (error) {
          log.warn({ vodId, error: extractErrorDetails(error).message }, 'Failed to fetch category info');
        }
      }

      const existingChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('start', '=', currentTimeSeconds)
        .executeTakeFirst();

      if (existingChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds });
        await db
          .updateTable('chapters')
          .set({ end: currentTimeSeconds })
          .where('id', '=', existingChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug(
          { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: currentTimeSeconds },
          'Created new chapter'
        );
        return;
      }

      const validatedChapter = ChapterCreateSchema.parse({
        vod_id: dbId,
        start: currentTimeSeconds,
        title: category.name,
        game_id: String(category.id),
      });
      await db
        .insertInto('chapters')
        .values({
          vod_id: validatedChapter.vod_id,
          game_id: validatedChapter.game_id,
          name: validatedChapter.title,
          image: bannerImage,
          start: validatedChapter.start,
        })
        .execute();

      await publishVodUpdate(ctx.tenantId, dbId);

      log.debug(
        { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: currentTimeSeconds },
        'Created new chapter'
      );
    });
  } catch (error) {
    log.error(createErrorContext(error, { dbId, vodId }), 'Failed to update chapter');
  }
}

export async function finalizeKickChapters(
  ctx: Omit<TenantContext, 'db'>,
  dbId: number,
  vodId: string,
  finalDurationSeconds: number
): Promise<void> {
  try {
    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const incompleteChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('end', 'is', null)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (incompleteChapter) {
        const endDuration = finalDurationSeconds - incompleteChapter.start;

        ChapterUpdateSchema.parse({
          end: endDuration,
        });
        await db
          .updateTable('chapters')
          .set({
            end: endDuration,
          })
          .where('id', '=', incompleteChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.info({ vodId, chapterId: incompleteChapter.id, finalDuration: endDuration }, 'Finalized last chapter');
      } else {
        log.debug({ vodId }, 'No incomplete chapters to finalize');
      }
    });
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to finalize chapters');
  }
}
