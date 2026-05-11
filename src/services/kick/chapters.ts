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

    let categoryGameId = String(category.id);
    let bannerImage: string | null = null;
    if (category.slug != null && category.slug !== '') {
      try {
        const categoryInfo = await getKickCategoryInfo(category.slug);
        if (categoryInfo) {
          categoryGameId = String(categoryInfo.id);
          bannerImage = categoryInfo.banner?.src ?? null;
        }
      } catch (error) {
        log.warn({ vodId, error: extractErrorDetails(error).message }, 'Failed to fetch category info');
      }
    }

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const lastChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (lastChapter && lastChapter.game_id === categoryGameId) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds, duration: currentTimeSeconds - lastChapter.start });
        await db
          .updateTable('chapters')
          .set({ end: currentTimeSeconds, duration: currentTimeSeconds - lastChapter.start })
          .where('id', '=', lastChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug({ vodId, chapterId: lastChapter.id, currentTime: currentTimeSeconds }, 'Updated chapter end time');
        return;
      }

      if (lastChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds, duration: currentTimeSeconds - lastChapter.start });
        await db
          .updateTable('chapters')
          .set({ end: currentTimeSeconds, duration: currentTimeSeconds - lastChapter.start })
          .where('id', '=', lastChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.debug({ vodId, chapterId: lastChapter.id }, 'Closed previous chapter');
      }

      const existingChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('start', '=', currentTimeSeconds)
        .executeTakeFirst();

      if (existingChapter) {
        ChapterUpdateSchema.parse({ end: currentTimeSeconds, duration: 0 });
        await db
          .updateTable('chapters')
          .set({ end: currentTimeSeconds, duration: 0 })
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
        duration: 0,
        end: currentTimeSeconds,
        title: category.name,
        game_id: categoryGameId,
      });
      await db
        .insertInto('chapters')
        .values({
          vod_id: validatedChapter.vod_id,
          game_id: validatedChapter.game_id,
          name: validatedChapter.title,
          image: bannerImage,
          start: validatedChapter.start,
          duration: validatedChapter.duration,
          end: validatedChapter.end,
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
        .where('end', '=', null)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      if (incompleteChapter) {
        const duration = finalDurationSeconds - incompleteChapter.start;

        ChapterUpdateSchema.parse({
          duration,
          end: finalDurationSeconds,
        });
        await db
          .updateTable('chapters')
          .set({
            duration,
            end: finalDurationSeconds,
          })
          .where('id', '=', incompleteChapter.id)
          .execute();

        await publishVodUpdate(ctx.tenantId, dbId);

        log.info({ vodId, chapterId: incompleteChapter.id, finalDuration: duration }, 'Finalized last chapter');
      } else {
        log.debug({ vodId }, 'No incomplete chapters to finalize');
      }
    });
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to finalize chapters');
  }
}
