import { getStreamerConfig } from '../config/loader.js';
import { getClient } from '../db/client.js';
import { triggerYoutubeUpload } from '../jobs/youtube.job.js';

interface Logger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
}

export async function queueYoutubeUpload(streamerId: string, vodId: string, filePath: string, uploadMode: 'vod' | 'all', platform: 'twitch' | 'kick', log: Logger): Promise<void> {
  const config = getStreamerConfig(streamerId);

  if (!config?.youtube?.auth) {
    log.info({ streamerId }, `YouTube not configured, skipping upload`);
    return;
  }

  const client = getClient(streamerId);

  if (!client) {
    log.warn({ streamerId }, `Database client not available for upload`);
    return;
  }

  const vodJobId = await triggerYoutubeUpload(streamerId, vodId, filePath, '', '', 'vod', platform);

  if (vodJobId) {
    log.info({ streamerId, vodId, jobId: vodJobId }, `Queued VOD upload job`);
  }

  if (uploadMode === 'all' && config.youtube.perGameUpload) {
    const chapters = await client.chapter.findMany({
      where: { vod_id: vodId },
      orderBy: { start: 'asc' },
    });

    const eligibleChapters = filterEligibleChapters(chapters, config.youtube.restrictedGames, log, streamerId);

    if (eligibleChapters.length > 0) {
      log.info({ streamerId, vodId, count: eligibleChapters.length }, `Queuing game upload(s) for VOD`);

      for (const chapter of eligibleChapters) {
        if (!chapter.name || chapter.start === (chapter.end || 0)) {
          continue;
        }

        const gameJobId = await triggerYoutubeUpload(streamerId, vodId, filePath, '', '', 'game', platform, undefined, chapter.name, chapter.game_id || undefined);

        if (gameJobId) {
          log.debug({ streamerId, vodId, gameId: chapter.game_id, gameName: chapter.name, jobId: gameJobId }, `Queued game upload job`);
        }
      }
    } else {
      log.debug({ streamerId, vodId }, `No eligible games found for VOD`);
    }
  }
}

export function filterEligibleChapters(
  chapters: Array<{ name: string | null; game_id: string | null; start: number; end: number | null }>,
  restrictedGames: string[],
  log: Logger,
  streamerId: string
): typeof chapters {
  return chapters.filter((chapter) => {
    if (!chapter.name) {
      log.debug({ streamerId, gameId: chapter.game_id }, `Skipping chapter without name`);
      return false;
    }

    if (restrictedGames.length > 0) {
      const isRestricted = restrictedGames.some((restricted) => chapter.name?.toLowerCase() === restricted.toLowerCase());

      if (isRestricted) {
        log.debug({ streamerId, gameName: chapter.name }, `Skipping restricted game`);
        return false;
      }
    }

    return true;
  });
}
