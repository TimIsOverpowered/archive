import { getTenantConfig } from '../config/loader.js';
import { getClient } from '../db/client.js';
import { triggerYoutubeUpload } from '../jobs/youtube.job.js';

interface Logger {
  info: (context: Record<string, unknown>, message: string) => void;
  debug: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
}

export async function queueYoutubeUpload(tenantId: string, vodId: number, filePath: string, uploadMode: 'vod' | 'all', platform: 'twitch' | 'kick', log: Logger): Promise<void> {
  const config = getTenantConfig(tenantId);

  if (!config?.youtube?.auth) {
    log.info({ tenantId }, `YouTube not configured, skipping upload`);
    return;
  }

  const client = getClient(tenantId);

  if (!client) {
    log.warn({ tenantId }, `Database client not available for upload`);
    return;
  }

  const vodJobId = await triggerYoutubeUpload(tenantId, String(vodId), filePath, '', '', 'vod', platform);

  if (vodJobId) {
    log.info({ tenantId, vodId, jobId: vodJobId }, `Queued VOD upload job`);
  }

  if (uploadMode === 'all' && config.youtube.perGameUpload) {
    const chapters = await client.chapter.findMany({
      where: { vod_id: vodId },
      orderBy: { start: 'asc' },
    });

    const eligibleChapters = filterEligibleChapters(chapters, config.youtube.restrictedGames, log, tenantId);

    if (eligibleChapters.length > 0) {
      log.info({ tenantId, vodId, count: eligibleChapters.length }, `Queuing game upload(s) for VOD`);

      for (const chapter of eligibleChapters) {
        if (!chapter.name || chapter.start === (chapter.end || 0)) {
          continue;
        }

        const gameJobId = await triggerYoutubeUpload(tenantId, String(vodId), filePath, '', '', 'game', platform, undefined, chapter.name, chapter.game_id || undefined);

        if (gameJobId) {
          log.debug({ tenantId, vodId, gameId: chapter.game_id, gameName: chapter.name, jobId: gameJobId }, `Queued game upload job`);
        }
      }
    } else {
      log.debug({ tenantId, vodId }, `No eligible games found for VOD`);
    }
  }
}

export function filterEligibleChapters(
  chapters: Array<{ name: string | null; game_id: string | null; start: number; end: number | null }>,
  restrictedGames: string[],
  log: Logger,
  tenantId: string
): typeof chapters {
  return chapters.filter((chapter) => {
    if (!chapter.name) {
      log.debug({ tenantId, gameId: chapter.game_id }, `Skipping chapter without name`);
      return false;
    }

    if (restrictedGames.length > 0) {
      const isRestricted = restrictedGames.some((restricted) => chapter.name?.toLowerCase() === restricted.toLowerCase());

      if (isRestricted) {
        log.debug({ tenantId, gameName: chapter.name }, `Skipping restricted game`);
        return false;
      }
    }

    return true;
  });
}
