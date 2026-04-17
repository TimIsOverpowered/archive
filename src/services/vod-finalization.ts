import { PLATFORMS, Platform } from '../types/platforms.js';
import { finalizeKickChapters } from './kick.js';
import { saveVodChapters as saveTwitchVodChapters } from './twitch/index.js';
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
    if (durationSeconds) {
      if (platform === PLATFORMS.KICK) {
        await finalizeKickChapters(ctx, dbId, vodId, durationSeconds);
      } else if (platform === PLATFORMS.TWITCH) {
        await saveTwitchVodChapters(ctx, dbId, vodId, durationSeconds);
      }
      await db.vod.update({
        where: { id: dbId },
        data: { duration: durationSeconds, is_live: false },
      });
    } else {
      await db.vod.update({
        where: { id: dbId },
        data: { is_live: false },
      });
    }
  });
}
