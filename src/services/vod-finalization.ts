import { Platform } from '../types/platforms.js';
import { getStrategy } from './platforms/strategy.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/streamer-client.js';
import { VodUpdateSchema } from '../config/schemas.js';
import { publishVodDurationUpdate } from './cache-invalidator.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

/** Options for finalizing a VOD after download completes. */
export interface FinalizeVodOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
  durationSeconds: number | null;
}

/**
 * Finalize a VOD after download: update duration, set is_live=false,
 * run platform-specific chapter finalization, and publish cache update.
 */
export async function finalizeVod(options: FinalizeVodOptions): Promise<void> {
  const { ctx, dbId, vodId, platform, durationSeconds } = options;
  const log = createAutoLogger(ctx.tenantId);

  const parsed = VodUpdateSchema.safeParse({
    duration: durationSeconds ?? undefined,
  });
  if (!parsed.success) {
    log.warn({ error: parsed.error.format() }, 'Invalid VOD update data');
    return;
  }

  await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    const strategy = getStrategy(platform);
    const dur = parsed.data.duration ?? null;
    if (dur != null && strategy?.finalizeChapters != null) {
      const finalize = strategy.finalizeChapters.bind(strategy);
      await db.transaction().execute(async (trx) => {
        await finalize({ tenantId: ctx.tenantId, config: ctx.config, platform, db: trx }, dbId, vodId, dur);
        await trx
          .updateTable('vods')
          .set({
            is_live: false,
            ...(dur !== null && { duration: dur }),
          })
          .where('id', '=', dbId)
          .execute();
      });
    } else {
      await db
        .updateTable('vods')
        .set({
          is_live: false,
          ...(dur !== null && { duration: dur }),
        })
        .where('id', '=', dbId)
        .execute();
    }

    await publishVodDurationUpdate(ctx.tenantId, dbId, dur ?? 0, false);
  });
}
