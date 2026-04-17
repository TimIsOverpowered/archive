import type { PrismaClient } from '../../../generated/streamer/client.js';
import type { AppLogger } from '../../utils/logger.js';
import { trimVideo, splitVideo, getDuration } from '../utils/ffmpeg.js';
import { uploadVideo } from '../../services/youtube/index.js';
import { initRichAlert, updateAlert, formatProgressMessage } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { createYoutubeUploadProgressHandler as createGameUploadProgressHandler } from './youtube-upload-progress.js';
import { YOUTUBE_MAX_DURATION } from '../../constants.js';
import type { TenantConfig } from '../../config/types.js';
import { deleteFileIfExists } from '../../utils/path.js';

export interface GameUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  chapterStart: number;
  chapterEnd: number;
  chapterName: string;
  chapterGameId?: string;
  title: string;
  description: string;
  db: PrismaClient;
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
  const { tenantId, dbId, chapterStart, chapterEnd, chapterGameId, title, description, db, chapterName, vodId, config } = ctx;
  const channelName = config.displayName || tenantId;

  const uploadAlertMessageId = await initRichAlert({
    title: '🎮 Game Upload Started',
    description: `${tenantId} - Uploading game clip to YouTube...`,
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
      })
    : () => {};

  const result = await uploadVideo(tenantId, channelName, trimmedPath, title, description, 'public', onUploadProgress);

  const createdGameRecord = await db.game.create({
    data: {
      vod_id: dbId,
      start_time: chapterStart,
      end_time: chapterEnd,
      video_provider: 'youtube',
      video_id: result.videoId,
      thumbnail_url: result.thumbnailUrl || null,
      game_id: chapterGameId || null,
      game_name: chapterName,
      title: chapterName,
    },
  });

  await deleteFileIfExists(trimmedPath);

  return { success: true, videoId: result.videoId, gameId: String(createdGameRecord.id) };
}

async function processSplitGameUpload(ctx: GameUploadContext, trimmedPath: string, trimmedDuration: number): Promise<GameUploadResult> {
  const { tenantId, dbId, chapterStart, chapterGameId, chapterName, title, description, config, db, vodId } = ctx;
  const totalParts = Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION);

  const splitAlertMessageId = await initRichAlert({
    title: `✂️ Game Clip Splitting in Progress`,
    description: `${tenantId} - Preparing ${totalParts} parts...`,
    status: 'warning',
    fields: [
      { name: 'Game Name', value: chapterName, inline: true },
      { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
      { name: 'Parts Count', value: String(totalParts), inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const splitPaths = await splitVideo(trimmedPath, trimmedDuration, YOUTUBE_MAX_DURATION, `${vodId}-game`, (percent: number) => {
    void updateAlert(splitAlertMessageId, {
      title: `✂️ Splitting Game Clip`,
      description: `${tenantId} - Game clip exceeds YouTube max duration`,
      status: 'warning',
      fields: [{ name: 'Progress', value: formatProgressMessage('Game Splitting', tenantId, percent), inline: false }],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    });
  });

  const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> = [];

  for (let i = 0; i < totalParts; i++) {
    const currentPartNum = i + 1;
    const startTime = i * YOUTUBE_MAX_DURATION;
    const endTime = Math.min(startTime + YOUTUBE_MAX_DURATION, trimmedDuration);
    const partTitle = i > 0 ? `${title} PART ${i + 1}` : title;

    const uploadAlertMessageId = await initRichAlert({
      title: `🎮 Game Upload (Part ${currentPartNum}/${totalParts})`,
      description: `${tenantId} - Uploading game clip part to YouTube...`,
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
          channelName: config.displayName || tenantId,
          gameName: chapterName,
          videoTitle: partTitle,
          part: currentPartNum,
          totalParts,
        })
      : () => {};

    const result = await uploadVideo(tenantId, config.displayName || tenantId, splitPaths[i], partTitle, description, 'public', onUploadProgress);

    const createdGameRecord = await db.game.create({
      data: {
        vod_id: dbId,
        start_time: startTime + chapterStart,
        end_time: endTime + chapterStart,
        video_provider: 'youtube',
        video_id: result.videoId,
        thumbnail_url: result.thumbnailUrl || null,
        game_id: chapterGameId || null,
        game_name: chapterName,
        title: chapterName,
      },
    });

    uploadedGameVideos.push({
      id: result.videoId,
      part: currentPartNum,
      startTime,
      endTime,
      gameId: String(createdGameRecord.id),
    });

    if (!config.settings.saveMP4) {
      await deleteFileIfExists(splitPaths[i]);
    }
  }

  void updateAlert(splitAlertMessageId, {
    title: `✅ Game Clip Splitting Complete`,
    description: `${tenantId} - Successfully split into ${totalParts} parts`,
    status: 'success',
    fields: [
      { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
      { name: 'Parts Count', value: String(totalParts), inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  });

  return { success: true, videos: uploadedGameVideos };
}
