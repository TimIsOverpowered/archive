import { ChapterCreateSchema, ChapterUpdateSchema } from '../../config/schemas.ts';
import { withDbRetry } from '../../db/streamer-client.ts';
import type { TenantContext } from '../../types/context.ts';
import { createErrorContext, extractErrorDetails } from '../../utils/error.ts';
import { childLogger } from '../../utils/logger.ts';
import { publishVodUpdate } from '../cache-invalidator.ts';
import { getKickCategoryInfo } from './category.ts';
import { getKickStreamStatus } from './live.ts';

const log = childLogger({ module: 'kick-chapters' });

/**
 * Update chapter boundaries during a live download.
 * @param currentTimeSeconds - Media position (seconds) of downloaded segments, NOT wall-clock elapsed time.
 */
export async function updateChapterDuringDownload(
  ctx: TenantContext,
  dbId: number,
  vodId: string,
  currentTimeSeconds: number
): Promise<void> {
  try {
    const { config } = ctx;
    const username = config.kick?.username;
    if (username == null || username === '') {
      log.warn({ dbId, vodId }, 'Kick username not configured');
      return;
    }

    const streamData = await getKickStreamStatus(username);
    if (!streamData?.category) {
      log.debug({ dbId, vodId }, 'No active stream or category data');
      return;
    }

    const { category } = streamData;

    const categoryGameId = String(category.id);
    let bannerImage: string | null = null;
    if (category.slug != null && category.slug !== '') {
      try {
        const categoryInfo = await getKickCategoryInfo(category.slug);
        if (categoryInfo) {
          bannerImage = categoryInfo.banner?.src ?? null;
        }
      } catch (error) {
        log.warn({ vodId, error: extractErrorDetails(error).message }, 'Failed to fetch category info');
      }
    }

    let updatedChapterId: number | null = null;

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const lastChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .orderBy('start', 'desc')
        .executeTakeFirst();

      const clampedTime = lastChapter?.end != null ? Math.max(currentTimeSeconds, lastChapter.end) : 0;

      if (lastChapter && lastChapter.game_id === categoryGameId) {
        ChapterUpdateSchema.parse({ end: clampedTime, duration: clampedTime - lastChapter.start });
        await db
          .updateTable('chapters')
          .set({ end: clampedTime, duration: clampedTime - lastChapter.start })
          .where('id', '=', lastChapter.id)
          .execute();

        updatedChapterId = lastChapter.id;
        log.debug({ vodId, chapterId: lastChapter.id, currentTime: clampedTime }, 'Updated chapter end time');
        return;
      }

      if (lastChapter) {
        ChapterUpdateSchema.parse({ end: clampedTime, duration: clampedTime - lastChapter.start });
        await db
          .updateTable('chapters')
          .set({ end: clampedTime, duration: clampedTime - lastChapter.start })
          .where('id', '=', lastChapter.id)
          .execute();

        updatedChapterId = lastChapter.id;
        log.debug({ vodId, chapterId: lastChapter.id }, 'Closed previous chapter');
      }

      const existingChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('start', '=', clampedTime)
        .executeTakeFirst();

      if (existingChapter) {
        ChapterUpdateSchema.parse({ end: clampedTime, duration: 0 });
        await db
          .updateTable('chapters')
          .set({ end: clampedTime, duration: 0 })
          .where('id', '=', existingChapter.id)
          .execute();

        updatedChapterId = existingChapter.id;
        log.debug(
          { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: clampedTime },
          'Created new chapter'
        );
        return;
      }

      const validatedChapter = ChapterCreateSchema.parse({
        vod_id: dbId,
        start: clampedTime,
        duration: 0,
        end: clampedTime,
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

      log.debug(
        { dbId, vodId, categoryId: category.id, categoryName: category.name, startTime: clampedTime },
        'Created new chapter'
      );
    });

    if (updatedChapterId != null) {
      try {
        await publishVodUpdate(ctx.tenantId, dbId);
      } catch (error) {
        log.warn({ error: extractErrorDetails(error).message, dbId, vodId }, 'Failed to publish chapter update');
      }
    }
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
    let finalizedChapterId: number | null = null;

    await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
      const incompleteChapter = await db
        .selectFrom('chapters')
        .selectAll()
        .where('vod_id', '=', dbId)
        .where('end', 'is', null)
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

        finalizedChapterId = incompleteChapter.id;
        log.info({ vodId, chapterId: incompleteChapter.id, finalDuration: duration }, 'Finalized last chapter');
      } else {
        const lastChapter = await db
          .selectFrom('chapters')
          .selectAll()
          .where('vod_id', '=', dbId)
          .orderBy('start', 'desc')
          .executeTakeFirst();

        if (lastChapter && (lastChapter.end === null || lastChapter.end < finalDurationSeconds)) {
          const duration = finalDurationSeconds - lastChapter.start;
          if (duration <= 0) {
            log.debug({ vodId }, 'Last chapter already covers full duration');
          } else {
            ChapterUpdateSchema.parse({ duration, end: finalDurationSeconds });
            await db
              .updateTable('chapters')
              .set({
                duration,
                end: finalDurationSeconds,
              })
              .where('id', '=', lastChapter.id)
              .execute();

            finalizedChapterId = lastChapter.id;
            log.info(
              { vodId, chapterId: lastChapter.id, finalDuration: duration },
              'Finalized last chapter (clock skew fix)'
            );
          }
        } else if (lastChapter && lastChapter.end != null && lastChapter.end > finalDurationSeconds) {
          const duration = finalDurationSeconds - lastChapter.start;
          if (duration <= 0) {
            log.warn(
              { vodId, chapterStart: lastChapter.start, finalDuration: finalDurationSeconds },
              'Last chapter start exceeds final duration'
            );
          } else {
            ChapterUpdateSchema.parse({ duration, end: finalDurationSeconds });
            await db
              .updateTable('chapters')
              .set({
                duration,
                end: finalDurationSeconds,
              })
              .where('id', '=', lastChapter.id)
              .execute();

            finalizedChapterId = lastChapter.id;
            log.info(
              { vodId, chapterId: lastChapter.id, overshotEnd: lastChapter.end, finalDuration: finalDurationSeconds },
              'Clamped last chapter end to final duration'
            );
          }
        } else {
          log.debug({ vodId }, 'No incomplete chapters to finalize');
        }
      }
    });

    if (finalizedChapterId != null) {
      try {
        await publishVodUpdate(ctx.tenantId, dbId);
      } catch (error) {
        log.warn({ error: extractErrorDetails(error).message, vodId }, 'Failed to publish chapter update');
      }
    }
  } catch (error) {
    log.error(createErrorContext(error, { vodId }), 'Failed to finalize chapters');
  }
}
