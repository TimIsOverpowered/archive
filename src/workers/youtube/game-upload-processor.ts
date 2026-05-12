import type { Kysely } from 'kysely';
import { GameUpsertSchema } from '../../config/schemas.js';
import type { TenantConfig } from '../../config/types.js';
import { getDisplayName } from '../../config/types.js';
import { YouTube } from '../../constants.js';
import type { StreamerDB } from '../../db/streamer-types.js';
import { publishGameUpdate, publishVodUpdate } from '../../services/cache-invalidator.js';
import { uploadVideo } from '../../services/youtube/index.js';
import type { Platform } from '../../types/platforms.js';
import { initRichAlert, createProgressBar } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import type { AppLogger } from '../../utils/logger.js';
import { deleteFileIfExists } from '../../utils/path.js';
import { safeUpdateAlert } from '../utils/alert-factories.js';
import { trimVideo, splitVideo, getMetadata } from '../utils/ffmpeg.js';
import { buildYoutubeMetadata } from './metadata-builder.js';
import { createYoutubeUploadProgressHandler } from './youtube-upload-progress.js';
import { invalidateGameTags } from '../../services/cache-tags.js';
import { invalidateVodStaticCache } from '../../services/vod-cache.js';

export interface GameUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  chapterStart: number;
  chapterDuration: number;
  chapterEnd: number;
  chapterName: string;
  chapterGameId?: string | undefined;
  chapterImage?: string | null | undefined;
  platform: Platform;
  epNumber: number;
  gameTitle?: string | undefined;
  displayName: string;
  db: Kysely<StreamerDB>;
  config: TenantConfig;
  log: AppLogger;
}

export interface GameUploadAndUpsertParams {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  chapterStart: number;
  chapterEnd: number;
  chapterDuration: number;
  chapterName: string;
  chapterGameId?: string | undefined;
  chapterImage?: string | null | undefined;
  platform: Platform;
  epNumber: number;
  gameTitle?: string | undefined;
  displayName: string;
  part?: number | undefined;
  totalParts?: number | undefined;
  db: Kysely<StreamerDB>;
  config: TenantConfig;
  log: AppLogger;
}

export type GameUploadResult =
  | { success: true; videoId: string; gameId: string; filePath: string }
  | {
      success: true;
      videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }>;
      filePath: string;
    }
  | { success: true; videoId: ''; gameId: ''; filePath: string };

async function uploadAndUpsertGame(params: GameUploadAndUpsertParams): Promise<{ videoId: string; gameId: string }> {
  const {
    tenantId,
    dbId,
    vodId,
    filePath,
    chapterStart,
    chapterDuration,
    chapterEnd,
    chapterName,
    chapterGameId,
    chapterImage,
    platform,
    epNumber,
    gameTitle,
    displayName,
    part,
    totalParts,
    db,
    config,
  } = params;
  const channelName = getDisplayName(config);
  const currentPartNum = part ?? 1;

  const dbTitle = gameTitle ?? `${chapterName} EP ${epNumber + (currentPartNum - 1)}`;

  const vodRecord = await db.selectFrom('vods').selectAll().where('id', '=', dbId).executeTakeFirst();
  if (!vodRecord) throw new Error(`VOD not found for dbId ${dbId}`);

  const { title: ytTitle, description: youtubeDescription } = buildYoutubeMetadata({
    channelName,
    platform,
    domainName: config.settings?.domainName ?? '',
    timezone: config.settings?.timezone ?? 'UTC',
    youtubeDescription: config.youtube?.description,
    gameName: gameTitle ?? chapterName,
    epNumber: gameTitle == null ? epNumber + (currentPartNum - 1) : undefined,
    vodRecord,
  });

  const uploadAlertMessageId = await initRichAlert({
    title: part != null ? `🎮 Game Upload (Part ${currentPartNum}/${totalParts})` : '🎮 Game Upload Started',
    description: `${displayName} - Uploading "${chapterName}" to YouTube`,
    status: 'warning',
    fields: [
      { name: 'Streamer', value: displayName, inline: true },
      { name: 'Game', value: chapterName, inline: true },
      { name: 'VOD ID', value: vodId, inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const onUploadProgress =
    uploadAlertMessageId != null
      ? createYoutubeUploadProgressHandler({
          messageId: uploadAlertMessageId,
          type: 'game',
          channelName,
          gameName: chapterName,
          videoTitle: ytTitle,
          privacyStatus: 'public',
          ...(part != null && totalParts != null && { part: currentPartNum, totalParts }),
        })
      : () => {};

  const result = await uploadVideo(
    tenantId,
    channelName,
    filePath,
    ytTitle,
    youtubeDescription,
    'public',
    onUploadProgress,
    chapterDuration
  );

  GameUpsertSchema.parse({
    game_id: chapterGameId,
    game_name: chapterName,
  });
  const gameRecord = await db
    .insertInto('games')
    .values({
      vod_id: dbId,
      start: chapterStart,
      duration: chapterDuration,
      end: chapterEnd,
      video_provider: 'youtube',
      video_id: result.videoId,
      thumbnail_url: result.thumbnailUrl ?? null,
      game_id: chapterGameId,
      game_name: chapterName,
      title: dbTitle,
      chapter_image: chapterImage,
    })
    .onConflict((oc) =>
      oc.columns(['vod_id', 'start', 'end']).doUpdateSet({
        video_id: result.videoId,
        thumbnail_url: result.thumbnailUrl ?? null,
        title: dbTitle,
        chapter_image: chapterImage,
      })
    )
    .returning('id')
    .executeTakeFirst();

  await publishVodUpdate(tenantId, dbId);
  await publishGameUpdate(tenantId);

  setTimeout(() => {
    invalidateVodStaticCache(tenantId, dbId).catch(() => {});
    invalidateGameTags(tenantId).catch(() => {});
  }, 3000);

  await deleteFileIfExists(filePath);

  if (gameRecord == null) throw new Error('Failed to insert game record');
  return { videoId: result.videoId, gameId: String(gameRecord.id) };
}

export async function processGameUpload(ctx: GameUploadContext): Promise<GameUploadResult> {
  const { filePath, chapterStart, chapterDuration, vodId, log, displayName, chapterName } = ctx;

  if (filePath === '') {
    throw new Error('File path is required for game upload');
  }

  const channelName = displayName;

  const trimAlertMessageId = await initRichAlert({
    title: `✂️ Trimming Game Clip`,
    description: `${channelName} - Extracting "${chapterName}" from VOD ${vodId}`,
    status: 'warning',
    fields: [
      { name: 'Game', value: chapterName, inline: true },
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Start Time', value: toHHMMSS(chapterStart), inline: true },
      { name: 'Duration', value: toHHMMSS(chapterDuration), inline: true },
    ],
    timestamp: new Date().toISOString(),
  });

  let trimFfmpegCmd: string | undefined;
  const startTime = Date.now();

  const trimmedPath = await trimVideo(
    filePath,
    chapterStart,
    chapterDuration,
    `${ctx.vodId}-game-${ctx.chapterGameId ?? 'unknown'}`,
    (percent: number) => {
      if (trimAlertMessageId == null) return;

      const elapsed = (Date.now() - startTime) / 1000;
      const eta = percent > 0 ? Math.round((elapsed / percent) * (100 - percent)) : 0;

      const alertFields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'Game', value: chapterName, inline: true },
        { name: 'Progress', value: createProgressBar(percent), inline: false },
      ];

      if (trimFfmpegCmd != null) {
        alertFields.push({ name: 'FFmpeg', value: `\`${trimFfmpegCmd.substring(0, 500)}\``, inline: false });
      }

      alertFields.push({ name: 'ETA', value: toHHMMSS(Math.max(0, eta)), inline: true });

      safeUpdateAlert(
        trimAlertMessageId,
        {
          title: `✂️ Trimming Game Clip`,
          description: `${channelName} - Extracting "${chapterName}" from VOD ${vodId}`,
          status: 'warning',
          fields: alertFields,
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        },
        log,
        vodId
      );
    },
    (cmd) => {
      trimFfmpegCmd = cmd;
    }
  );

  safeUpdateAlert(
    trimAlertMessageId,
    {
      title: `✅ Game Clip Trimmed`,
      description: `${channelName} - Successfully trimmed "${chapterName}"`,
      status: 'success',
      fields: [
        { name: 'Game', value: chapterName, inline: true },
        { name: 'VOD ID', value: vodId, inline: true },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    },
    log,
    vodId
  );

  const metadata = await getMetadata(trimmedPath);
  if (!metadata) {
    throw new Error(`Trimmed file has invalid duration or no video stream: ${trimmedPath}`);
  }
  const trimmedDuration = metadata.duration;

  const gameExceedsYoutubeMax = trimmedDuration > YouTube.MAX_DURATION;

  if (gameExceedsYoutubeMax === true) {
    return await processSplitGameUpload({ ...ctx, displayName: channelName }, trimmedPath, trimmedDuration);
  } else {
    return await processSingleGameUpload({ ...ctx, displayName: channelName }, trimmedPath);
  }
}

async function processSingleGameUpload(ctx: GameUploadContext, trimmedPath: string): Promise<GameUploadResult> {
  const {
    tenantId,
    dbId,
    vodId,
    chapterStart,
    chapterEnd,
    chapterDuration,
    chapterGameId,
    chapterImage,
    platform,
    epNumber,
    gameTitle,
    displayName,
    db,
    chapterName: gameName,
    config,
    log,
  } = ctx;

  const result = await uploadAndUpsertGame({
    tenantId,
    dbId,
    vodId,
    filePath: trimmedPath,
    chapterStart,
    chapterEnd,
    chapterDuration,
    chapterName: gameName,
    chapterGameId,
    chapterImage,
    platform,
    epNumber,
    gameTitle,
    displayName,
    db,
    config,
    log,
  });

  return { success: true, ...result, filePath: ctx.filePath };
}

async function processSplitGameUpload(
  ctx: GameUploadContext,
  trimmedPath: string,
  trimmedDuration: number
): Promise<GameUploadResult> {
  const {
    tenantId,
    dbId,
    chapterStart,
    chapterGameId,
    chapterImage,
    platform,
    chapterName,
    epNumber,
    gameTitle,
    displayName,
    config,
    db,
    vodId,
    log,
  } = ctx;
  const channelName = displayName;
  const totalParts = Math.ceil(trimmedDuration / YouTube.MAX_DURATION);

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

  let splitGameFfmpegCmd: string | undefined;
  const splitPaths = await splitVideo(
    trimmedPath,
    trimmedDuration,
    YouTube.MAX_DURATION,
    `${vodId}-game`,
    (percent: number) => {
      const alertFields: Array<{ name: string; value: string; inline: boolean }> = [
        { name: 'Progress', value: createProgressBar(percent), inline: false },
      ];
      if (splitGameFfmpegCmd != null) {
        alertFields.push({ name: 'FFmpeg', value: `\`${splitGameFfmpegCmd.substring(0, 500)}\``, inline: false });
      }
      safeUpdateAlert(
        splitAlertMessageId,
        {
          title: `✂️ Splitting Game Clip`,
          description: `${channelName} - Game clip exceeds YouTube max duration`,
          status: 'warning',
          fields: alertFields,
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        },
        log,
        vodId
      );
    },
    (cmd) => {
      splitGameFfmpegCmd = cmd;
    }
  );

  const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> =
    [];

  for (let i = 0; i < totalParts; i++) {
    const currentPartNum = i + 1;
    const startTime = i * YouTube.MAX_DURATION;
    const endTime = Math.min(startTime + YouTube.MAX_DURATION, trimmedDuration);
    const splitPath = splitPaths[i];
    if (splitPath == null) {
      log.warn({ part: currentPartNum, totalParts }, 'Missing split path for part');
      continue;
    }

    const uploadResult = await uploadAndUpsertGame({
      tenantId,
      dbId,
      vodId,
      filePath: splitPath,
      chapterStart: startTime + chapterStart,
      chapterDuration: endTime - startTime,
      chapterName,
      chapterEnd: chapterStart + (endTime - startTime),
      chapterGameId,
      chapterImage,
      platform,
      epNumber,
      gameTitle,
      displayName,
      part: currentPartNum,
      totalParts,
      db,
      config,
      log,
    });

    uploadedGameVideos.push({
      id: uploadResult.videoId,
      part: currentPartNum,
      startTime,
      endTime,
      gameId: uploadResult.gameId,
    });
  }

  safeUpdateAlert(
    splitAlertMessageId,
    {
      title: `✅ Game Clip Splitting Complete`,
      description: `${channelName} - Successfully split into ${totalParts} parts`,
      status: 'success',
      fields: [
        { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
        { name: 'Parts Count', value: String(totalParts), inline: false },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    },
    log,
    vodId
  );

  return { success: true, videos: uploadedGameVideos, filePath: ctx.filePath };
}
