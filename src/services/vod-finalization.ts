import { treeifyError } from 'zod';
import { VodUpdateSchema } from '../config/schemas.js';
import { withDbRetry } from '../db/streamer-client.js';
import { TenantContext } from '../types/context.js';
import { Platform } from '../types/platforms.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { publishVodDurationUpdate, publishVodUpdate } from './cache-invalidator.js';
import { getStrategy } from './platforms/strategy.js';

/** Options for finalizing a VOD after download completes. */
export interface FinalizeVodOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
  durationSeconds: number | null;
}

/**
 * Mark a VOD as offline by setting is_live=false and publishing cache updates.
 * Used when a stream ends, a job exhausts retries, or a VOD is deleted by the platform.
 */
export async function markVodOffline(options: {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
}): Promise<void> {
  const { ctx, dbId, vodId, platform } = options;
  const log = createAutoLogger(ctx.tenantId);

  await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    await db.updateTable('vods').set({ is_live: false }).where('id', '=', dbId).execute();
  });

  await publishVodUpdate(ctx.tenantId, dbId);

  log.info({ dbId, vodId, platform }, 'VOD marked offline');
}

/**
 * Finalize a VOD after download: update duration, set is_live=false,
 * run platform-specific chapter finalization, and publish cache update.
 */
export async function finalizeVod(options: FinalizeVodOptions): Promise<void> {
  const { ctx, dbId, vodId, platform, durationSeconds } = options;
  const log = createAutoLogger(ctx.tenantId);

  const parsedDuration = VodUpdateSchema.safeParse({ duration: durationSeconds ?? undefined });
  if (!parsedDuration.success) {
    log.warn({ error: treeifyError(parsedDuration.error) }, 'Invalid VOD duration — is_live will still be cleared');
  }

  const dur = parsedDuration.success ? (parsedDuration.data.duration ?? null) : null;

  if (dur != null) {
    const strategy = getStrategy(platform);
    if (strategy != null && strategy.finalizeChapters != null) {
      await strategy.finalizeChapters({ ...ctx, platform, db: ctx.db }, dbId, vodId, dur);
    }
  }

  await withDbRetry(ctx.tenantId, ctx.config, async (db) => {
    await db
      .updateTable('vods')
      .set({ is_live: false, ...(dur != null ? { duration: dur } : {}) })
      .where('id', '=', dbId)
      .execute();
  });

  await publishVodDurationUpdate(ctx.tenantId, dbId, dur ?? 0, false);

  // Guarantee the static cache drops the stale `is_live: true` state
  await publishVodUpdate(ctx.tenantId, dbId);
}
