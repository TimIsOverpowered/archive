import { Platform } from '../types/platforms.js';
import { getStrategy } from './platforms/strategy.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/client.js';
import { VodUpdateSchema } from '../config/schemas.js';
import { publishVodDurationUpdate } from './cache-invalidator.js';

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

  await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    const strategy = getStrategy(platform);
    if (durationSeconds && strategy?.finalizeChapters) {
      await strategy.finalizeChapters(
        { tenantId: ctx.tenantId, config: ctx.config, platform, db },
        dbId,
        vodId,
        durationSeconds
      );
    }
    VodUpdateSchema.parse({
      duration: durationSeconds ?? undefined,
    });
    await db
      .updateTable('vods')
      .set({
        is_live: false,
        ...(durationSeconds !== null && { duration: durationSeconds }),
      })
      .where('id', '=', dbId)
      .execute();

    await publishVodDurationUpdate(ctx.tenantId, dbId, durationSeconds ?? 0, false);
  });
}
