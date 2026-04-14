import type { PrismaClient } from '../../generated/streamer/client';
import { PLATFORMS, Platform } from '../types/platforms';
import { finalizeKickChapters } from './kick.js';
import { saveVodChapters as saveTwitchVodChapters } from './twitch/index.js';

export interface FinalizeVodOptions {
  dbId: number;
  vodId: string;
  platform: Platform;
  tenantId: string;
  durationSeconds: number | null;
  streamerClient: PrismaClient;
}

export async function finalizeVod(options: FinalizeVodOptions): Promise<void> {
  const { dbId, vodId, platform, tenantId, durationSeconds, streamerClient } = options;

  if (durationSeconds) {
    if (platform === PLATFORMS.KICK) {
      await finalizeKickChapters(dbId, vodId, durationSeconds, streamerClient);
    } else if (platform === PLATFORMS.TWITCH) {
      await saveTwitchVodChapters(dbId, vodId, tenantId, durationSeconds, streamerClient);
    }
    await streamerClient.vod.update({
      where: { id: dbId },
      data: { duration: durationSeconds, is_live: false },
    });
  } else {
    await streamerClient.vod.update({
      where: { id: dbId },
      data: { is_live: false },
    });
  }
}
