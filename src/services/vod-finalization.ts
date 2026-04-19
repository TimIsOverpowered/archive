import { Platform } from '../types/platforms.js';
import { getStrategy } from './platforms/strategy.js';
import { TenantContext } from '../types/context.js';
import { withDbRetry } from '../db/client.js';

export interface FinalizeVodOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
  durationSeconds: number | null;
}

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
    await db.vod.update({
      where: { id: dbId },
      data: {
        is_live: false,
        ...(durationSeconds !== null && { duration: durationSeconds }),
      },
    });
  });
}
