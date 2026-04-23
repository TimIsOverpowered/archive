import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types.js';
import type { AppLogger } from '../../utils/logger.js';
import { trimVideo, splitVideo, getDuration } from '../utils/ffmpeg.js';
import { uploadVideo } from '../../services/youtube/index.js';
import { initRichAlert, updateAlert, createProgressBar } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { createYoutubeUploadProgressHandler as createGameUploadProgressHandler } from './youtube-upload-progress.js';
import { YOUTUBE_MAX_DURATION } from '../../constants.js';
import type { TenantConfig } from '../../config/types.js';
import { getDisplayName } from '../../config/types.js';
import { deleteFileIfExists } from '../../utils/path.js';
import { GameUpsertSchema } from '../../config/schemas.js';
import { publishVodUpdate } from '../../services/cache-invalidator.js';
import { extractErrorDetails } from '../../utils/error.js';

export interface GameUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  chapterStart: number;
  chapterEnd: number;
  chapterName: string;
  chapterGameId?: string | undefined;
  title: string;
  description: string;
  db: Kysely<StreamerDB>;
  config: TenantConfig;
  log: AppLogger;
}

export type GameUploadResult =
  | { success: true; videoId: string; gameId: string }
  | { success: true; videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> }
  | { success: true; videoId: ''; gameId: '' };

export async function processGameUpload(ctx: GameUploadContext): Promise<GameUploadResult> {
  const { filePath, chapterStart, chapterEnd } = ctx;

  if (!filePath) {
    throw new Error('File path is required for game upload');
  }

  const trimmedPath = await trimVideo(filePath, chapterStart, chapterEnd, `${ctx.vodId}-${ctx.chapterName}`);
  const trimmedDuration = (await getDuration(trimmedPath)) ?? 0;

  const gameExceedsYoutubeMax = trimmedDuration > YOUTUBE_MAX_DURATION;

  if (gameExceedsYoutubeMax) {
    return await processSplitGameUpload(ctx, trimmedPath, trimmedDuration);
  } else {
    return await processSingleGameUpload(ctx, trimmedPath);
  }
}

async function processSingleGameUpload(ctx: GameUploadContext, trimmedPath: string): Promise<GameUploadResult> {
  const {
    tenantId,
    dbId,
    chapterStart,
    chapterEnd,
    chapterGameId,
    title,
    description,
    db,
    chapterName,
    vodId,
    config,
  } = ctx;
  const channelName = getDisplayName(config);
  const duration = chapterEnd - chapterStart;

  const uploadAlertMessageId = await initRichAlert({
    title: '🎮 Game Upload Started',
    description: `${channelName} - Uploading game clip to YouTube...`,
    status: 'warning',
    fields: [
      { name: 'Game Name', value: chapterName, inline: true },
      { name: 'VOD ID', value: vodId, inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const onUploadProgress = uploadAlertMessageId
    ? createGameUploadProgressHandler({
        messageId: uploadAlertMessageId,
        type: 'game',
        channelName,
        gameName: chapterName,
        videoTitle: title,
        privacyStatus: 'public',
      })
    : () => {};

  const result = await uploadVideo(
    tenantId,
    channelName,
    trimmedPath,
    title,
    description,
    'public',
    onUploadProgress,
    duration
  );

  GameUpsertSchema.parse({
    game_id: chapterGameId,
    game_name: chapterName,
  });
  const gameRecord = await db
    .insertInto('games')
    .values({
      vod_id: dbId,
      start_time: chapterStart,
      end_time: chapterEnd,
      video_provider: 'youtube',
      video_id: result.videoId,
      thumbnail_url: result.thumbnailUrl || null,
      game_id: chapterGameId,
      game_name: chapterName,
      title: chapterName,
    })
    .onConflict((oc) =>
      oc.columns(['vod_id', 'start_time', 'end_time']).doUpdateSet({
        video_provider: 'youtube',
        video_id: result.videoId,
        thumbnail_url: result.thumbnailUrl || null,
        game_id: chapterGameId,
        game_name: chapterName,
        title: chapterName,
      })
    )
    .returning('id')
    .executeTakeFirst();

  await publishVodUpdate(tenantId, dbId);

  await deleteFileIfExists(trimmedPath);

  return { success: true, videoId: result.videoId, gameId: String(gameRecord!.id) };
}

async function processSplitGameUpload(
  ctx: GameUploadContext,
  trimmedPath: string,
  trimmedDuration: number
): Promise<GameUploadResult> {
  const { tenantId, dbId, chapterStart, chapterGameId, chapterName, title, description, config, db, vodId, log } = ctx;
  const channelName = getDisplayName(config);
  const totalParts = Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION);

  const splitAlertMessageId = await initRichAlert({
    title: `✂️ Game Clip Splitting in Progress`,
    description: `${channelName} - Preparing ${totalParts} parts...`,
    status: 'warning',
    fields: [
      { name: 'Game Name', value: chapterName, inline: true },
      { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
      { name: 'Parts Count', value: String(totalParts), inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const splitPaths = await splitVideo(
    trimmedPath,
    trimmedDuration,
    YOUTUBE_MAX_DURATION,
    `${vodId}-game`,
    (percent: number) => {
      updateAlert(splitAlertMessageId, {
        title: `✂️ Splitting Game Clip`,
        description: `${channelName} - Game clip exceeds YouTube max duration`,
        status: 'warning',
        fields: [{ name: 'Progress', value: createProgressBar(percent), inline: false }],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      }).catch((err) => {
        log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
      });
    }
  );

  const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> =
    [];

  for (let i = 0; i < totalParts; i++) {
    const currentPartNum = i + 1;
    const startTime = i * YOUTUBE_MAX_DURATION;
    const endTime = Math.min(startTime + YOUTUBE_MAX_DURATION, trimmedDuration);
    const partDuration = endTime - startTime;
    const partTitle = i > 0 ? `${title} PART ${i + 1}` : title;

    const splitPath = splitPaths[i];
    if (!splitPath) {
      log.warn({ part: currentPartNum, totalParts }, `Missing split path for part ${currentPartNum}`);
      continue;
    }

    const uploadAlertMessageId = await initRichAlert({
      title: `🎮 Game Upload (Part ${currentPartNum}/${totalParts})`,
      description: `${channelName} - Uploading game clip part to YouTube...`,
      status: 'warning',
      fields: [
        { name: 'Game Name', value: chapterName, inline: true },
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
      ],
      timestamp: new Date().toISOString(),
    });

    const onUploadProgress = uploadAlertMessageId
      ? createGameUploadProgressHandler({
          messageId: uploadAlertMessageId,
          type: 'game',
          channelName: getDisplayName(config),
          gameName: chapterName,
          videoTitle: partTitle,
          part: currentPartNum,
          totalParts,
          privacyStatus: 'public',
        })
      : () => {};

    const result = await uploadVideo(
      tenantId,
      getDisplayName(config),
      splitPath,
      partTitle,
      description,
      'public',
      onUploadProgress,
      partDuration
    );

    GameUpsertSchema.parse({
      game_id: chapterGameId,
      game_name: chapterName,
    });
    const gameRecord = await db
      .insertInto('games')
      .values({
        vod_id: dbId,
        start_time: startTime + chapterStart,
        end_time: endTime + chapterStart,
        video_provider: 'youtube',
        video_id: result.videoId,
        thumbnail_url: result.thumbnailUrl || null,
        game_id: chapterGameId,
        game_name: chapterName,
        title: chapterName,
      })
      .onConflict((oc) =>
        oc.columns(['vod_id', 'start_time', 'end_time']).doUpdateSet({
          video_provider: 'youtube',
          video_id: result.videoId,
          thumbnail_url: result.thumbnailUrl || null,
          game_id: chapterGameId,
          game_name: chapterName,
          title: chapterName,
        })
      )
      .returning('id')
      .executeTakeFirst();

    await publishVodUpdate(tenantId, dbId);

    uploadedGameVideos.push({
      id: result.videoId,
      part: currentPartNum,
      startTime,
      endTime,
      gameId: String(gameRecord!.id),
    });

    if (!config.settings.saveMP4) {
      await deleteFileIfExists(splitPath);
    }
  }

  updateAlert(splitAlertMessageId, {
    title: `✅ Game Clip Splitting Complete`,
    description: `${channelName} - Successfully split into ${totalParts} parts`,
    status: 'success',
    fields: [
      { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
      { name: 'Parts Count', value: String(totalParts), inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  }).catch((err) => {
    log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
  });

  return { success: true, videos: uploadedGameVideos };
}
