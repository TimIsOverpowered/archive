import type { PrismaClient } from '../../generated/streamer/client';
import { finalizeKickChapters } from './kick.js';
import { saveVodChapters as saveTwitchVodChapters } from './twitch.js';

export interface FinalizeVodOptions {
  dbId: number;
  vodId: string;
  platform: 'twitch' | 'kick';
  tenantId: string;
  durationSeconds: number | null;
  streamerClient: PrismaClient;
}

export async function finalizeVod(options: FinalizeVodOptions): Promise<void> {
  const { dbId, vodId, platform, tenantId, durationSeconds, streamerClient } = options;

  if (durationSeconds) {
    if (platform === 'kick') {
      await finalizeKickChapters(dbId, vodId, durationSeconds, streamerClient);
    } else if (platform === 'twitch') {
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
