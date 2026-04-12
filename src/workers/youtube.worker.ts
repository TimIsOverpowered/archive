import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

import type { YoutubeUploadJob, YoutubeUploadResult, YoutubeVodUploadJob, YoutubeGameUploadJob } from './jobs/queues.js';
import { splitVideo, trimVideo, getDuration, deleteFile } from '../utils/ffmpeg.js';
import { uploadVideo, linkParts } from '../services/youtube.js';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { toHHMMSS } from '../utils/formatting.js';
import { createYoutubeUploadProgressHandler } from '../utils/youtube-upload-progress.js';
import { getJobContext } from './job-context.js';
import { getTenantConfig } from '../config/loader.js';

const YOUTUBE_MAX_DURATION = 43199; // YouTube hard limit: 12 hours - 1 second (720 minutes)

type TenantConfig = ReturnType<typeof getTenantConfig>;
type DbClient = ReturnType<Awaited<ReturnType<typeof getJobContext>>['db']['vod']['findUnique']>;

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { tenantId, dbId, vodId, type } = job.data;

  const log = createAutoLogger(String(tenantId));
  const { config, db } = await getJobContext(tenantId);

  if (!config || !config.youtube) {
    throw new Error(`YouTube not configured for tenant ${tenantId}`);
  }

  try {
    if (type === 'vod') {
      return await processVodUpload(job.data, config, db, vodId, log);
    } else {
      return await processGameUpload(job.data, config, db, vodId, log);
    }
  } catch (error) {
    const details = extractErrorDetails(error);

    log.error(
      {
        ...details,
        vodId,
        tenantId,
      },
      `YouTube upload failed for ${vodId}`
    );

    await db.vodUpload.updateMany({
      where: { vod_id: dbId },
      data: { status: 'FAILED' },
    });

    throw error;
  }
};

// ============== VOD Processing ==============

async function processVodUpload(
  job: YoutubeVodUploadJob,
  config: NonNullable<TenantConfig>,
  db: any,
  vodId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<Extract<YoutubeUploadResult, { videos: Array<{ id: string; part: number }> }>> {
  const { tenantId, dbId, filePath, dmcaProcessed } = job;
  const vodRecord = await db.vod.findUnique({ where: { id: dbId } });

  if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

  const privacyStatus = config.youtube!.public ? 'public' : 'unlisted';
  const splitDuration = getEffectiveSplitDuration(config.youtube!.splitDuration);
  const duration = (await getDuration(filePath)) ?? 0;

  const channelName = config.displayName || tenantId;
  const platformName = vodRecord.platform.charAt(0).toUpperCase() + vodRecord.platform.slice(1);
  const dateFormatted = formatVodDate(vodRecord.created_at, config);
  const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
  const domainName = config.settings?.domainName || 'localhost';

  const needsSplitting = duration > splitDuration;
  const uploadedVideos: Array<{ id: string; part: number }> = [];

  if (needsSplitting) {
    const totalParts = Math.ceil(duration / splitDuration);

    // Create splitting progress alert
    let splitAlertMessageId: string | null = null;
    if (isAlertsEnabled()) {
      splitAlertMessageId = await sendRichAlert({
        title: `📺 VOD Splitting in Progress`,
        description: `${tenantId} - Preparing ${totalParts} parts...`,
        status: 'warning',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
          { name: 'Parts Count', value: String(totalParts), inline: false },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    const parts = await splitVideo(filePath, duration, splitDuration, vodId, (percent: number) => {
      if (splitAlertMessageId && isAlertsEnabled()) {
        updateDiscordEmbed(splitAlertMessageId, {
          title: `📺 Splitting VOD`,
          description: `${tenantId} - Preparing video parts for upload`,
          status: 'warning',
          fields: [{ name: 'Progress', value: formatProgressMessage('VOD Splitting', tenantId, percent), inline: false }],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
      }
    });

    for (let i = 0; i < parts.length; i++) {
      const currentPartNum = i + 1;

      let uploadAlertMessageId: string | null = null;
      if (isAlertsEnabled()) {
        uploadAlertMessageId = await sendRichAlert({
          title: `📺 YouTube Upload (Part ${currentPartNum}/${totalParts})`,
          description: `${tenantId} - Uploading video part to YouTube...`,
          status: 'warning',
          fields: [
            { name: 'VOD ID', value: vodId, inline: true },
            { name: 'Platform', value: platformName.toUpperCase(), inline: true },
            { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
          ],
          timestamp: new Date().toISOString(),
        });
      }

      const partTitle = `${channelName} ${platformName} VOD - ${dateFormatted}${i > 0 ? ` PART ${i + 1}` : ''}`;
      const youtubeDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube!.description || ''}`;

      let result;
      try {
        const onUploadProgress = createYoutubeUploadProgressHandler({
          messageId: uploadAlertMessageId,
          type: 'vod',
          channelName,
          videoTitle: partTitle,
          part: currentPartNum,
          totalParts,
        });

        result = await uploadVideo(tenantId, channelName, parts[i], partTitle, youtubeDescription, privacyStatus, onUploadProgress);

        uploadedVideos.push({ id: result.videoId, part: i + 1 });
      } catch (error) {
        throw error;
      }

      if (!config.settings.saveMP4) {
        await deleteFile(parts[i]);
      }
    }

    // Update splitting alert on completion
    if (splitAlertMessageId && isAlertsEnabled()) {
      updateDiscordEmbed(splitAlertMessageId, {
        title: `✅ VOD Splitting Complete`,
        description: `${tenantId} - Successfully split into ${totalParts} parts`,
        status: 'success',
        fields: [
          { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
          { name: 'Parts Count', value: String(totalParts), inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }
  } else {
    const vodTitle = `${channelName} ${platformName} VOD - ${dateFormatted}`;
    const youtubeDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube!.description || ''}`;

    let uploadAlertMessageId: string | null = null;
    if (isAlertsEnabled()) {
      uploadAlertMessageId = await sendRichAlert({
        title: `📺 YouTube Upload Started`,
        description: `${tenantId} - Uploading VOD to YouTube...`,
        status: 'warning',
        fields: [
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Platform', value: platformName.toUpperCase(), inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    const result = await uploadVideo(
      tenantId,
      channelName,
      filePath,
      vodTitle,
      youtubeDescription,
      privacyStatus,
      createYoutubeUploadProgressHandler({
        messageId: uploadAlertMessageId,
        type: 'vod',
        channelName,
        videoTitle: vodTitle,
      })
    );

    uploadedVideos.push({ id: result.videoId, part: 1 });

    if (!config.settings.saveMP4 || dmcaProcessed === true) {
      await deleteFile(filePath);
    }
  }

  for (const video of uploadedVideos) {
    await db.vodUpload.create({
      data: {
        vod_id: dbId,
        upload_id: video.id,
        type: 'vod',
        part: video.part,
        status: 'COMPLETED',
      },
    });
  }

  if (uploadedVideos.length > 1) {
    setTimeout(() => {
      void linkParts(tenantId, uploadedVideos);
    }, 60000);
  }

  resetFailures(tenantId);

  return { success: true, videos: uploadedVideos };
}

// ============== Game Processing ==============

async function processGameUpload(
  job: YoutubeGameUploadJob,
  config: NonNullable<TenantConfig>,
  db: any,
  vodId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<Extract<YoutubeUploadResult, { videoId: string } | { videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> }>> {
  const { tenantId, dbId, filePath, platform, chapterName, chapterStart, chapterEnd, chapterGameId, title, description } = job;

  const hasTwitch = config.twitch?.enabled === true;
  const hasKick = config.kick?.enabled === true;

  if (hasTwitch && hasKick) {
    const isMainPlatform = platform === 'twitch' ? config.twitch?.mainPlatform : config.kick?.mainPlatform;

    if (!isMainPlatform) {
      log.info(`[${vodId}] Skipping game upload: ${platform} is not main platform (simulcast mode)`);

      await db.game.updateMany({
        where: { vod_id: dbId },
        data: { video_provider: null, video_id: null, thumbnail_url: null },
      });

      resetFailures(tenantId);

      return { success: true, videoId: '', gameId: '' };
    }
  }

  const trimmedPath = await trimVideo(filePath, chapterStart, chapterEnd, `${vodId}-${chapterName}`);
  const trimmedDuration = (await getDuration(trimmedPath)) ?? 0;

  const gameExceedsYoutubeMax = trimmedDuration > YOUTUBE_MAX_DURATION;

  if (gameExceedsYoutubeMax) {
    log.info({ duration: trimmedDuration, parts: Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION) }, `Game clip exceeds YouTube max duration, auto-splitting`);

    return await processSplitGameUpload(job, trimmedPath, trimmedDuration, config, db, vodId, log);
  } else {
    return await processSingleGameUpload(job, trimmedPath, config, db, vodId, log);
  }
}

async function processSingleGameUpload(
  job: YoutubeGameUploadJob,
  trimmedPath: string,
  config: NonNullable<TenantConfig>,
  db: any,
  vodId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<Extract<YoutubeUploadResult, { videoId: string }>> {
  const { tenantId, dbId, chapterStart, chapterEnd, chapterGameId, title, description } = job;
  const channelName = config.displayName || tenantId;

  // Send initial upload alert for single game uploads (non-split)
  let uploadAlertMessageId: string | null = null;
  if (isAlertsEnabled()) {
    uploadAlertMessageId = await sendRichAlert({
      title: `🎮 Game Upload Started`,
      description: `${tenantId} - Uploading game clip to YouTube...`,
      status: 'warning',
      fields: [
        { name: 'Game Name', value: job.chapterName, inline: true },
        { name: 'VOD ID', value: vodId, inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  const result = await uploadVideo(
    tenantId,
    channelName,
    trimmedPath,
    title,
    description,
    'public',
    createYoutubeUploadProgressHandler({
      messageId: uploadAlertMessageId,
      type: 'game',
      channelName,
      gameName: job.chapterName,
    })
  );

  const createdGameRecord = await db.game.create({
    data: {
      vod_id: dbId,
      start_time: chapterStart,
      end_time: chapterEnd,
      video_provider: 'youtube',
      video_id: result.videoId,
      thumbnail_url: result.thumbnailUrl || null,
      game_id: chapterGameId || null,
      game_name: job.chapterName,
      title: job.chapterName,
    },
  });

  await deleteFile(trimmedPath);

  resetFailures(tenantId);

  return { success: true, videoId: result.videoId, gameId: String(createdGameRecord.id) };
}

async function processSplitGameUpload(
  job: YoutubeGameUploadJob,
  trimmedPath: string,
  trimmedDuration: number,
  config: NonNullable<TenantConfig>,
  db: any,
  vodId: string,
  log: ReturnType<typeof createAutoLogger>
): Promise<Extract<YoutubeUploadResult, { videos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> }>> {
  const { tenantId, dbId, chapterStart, chapterGameId } = job;
  const totalParts = Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION);

  // Create splitting progress alert for game clips
  let splitAlertMessageId: string | null = null;
  if (isAlertsEnabled()) {
    splitAlertMessageId = await sendRichAlert({
      title: `✂️ Game Clip Splitting in Progress`,
      description: `${tenantId} - Preparing ${totalParts} parts...`,
      status: 'warning',
      fields: [
        { name: 'Game Name', value: job.chapterName, inline: true },
        { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
        { name: 'Parts Count', value: String(totalParts), inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  }

  const splitPaths = await splitVideo(trimmedPath, trimmedDuration, YOUTUBE_MAX_DURATION, `${vodId}-game`, (percent: number) => {
    if (splitAlertMessageId && isAlertsEnabled()) {
      updateDiscordEmbed(splitAlertMessageId, {
        title: `✂️ Splitting Game Clip`,
        description: `${tenantId} - Game clip exceeds YouTube max duration`,
        status: 'warning',
        fields: [{ name: 'Progress', value: formatProgressMessage('Game Splitting', tenantId, percent), inline: false }],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }
  });

  const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId: string }> = [];

  for (let i = 0; i < totalParts; i++) {
    const currentPartNum = i + 1;
    const startTime = i * YOUTUBE_MAX_DURATION;
    const endTime = Math.min(startTime + YOUTUBE_MAX_DURATION, trimmedDuration);

    const partTitle = i > 0 ? `${job.title} PART ${i + 1}` : job.title;

    let uploadAlertMessageId: string | null = null;
    if (isAlertsEnabled()) {
      uploadAlertMessageId = await sendRichAlert({
        title: `🎮 Game Upload (Part ${currentPartNum}/${totalParts})`,
        description: `${tenantId} - Uploading game clip part to YouTube...`,
        status: 'warning',
        fields: [
          { name: 'Game Name', value: job.chapterName, inline: true },
          { name: 'VOD ID', value: vodId, inline: true },
          { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    let result;
    try {
      const onUploadProgress = createYoutubeUploadProgressHandler({
        messageId: uploadAlertMessageId,
        type: 'game',
        channelName: config.displayName || tenantId,
        videoTitle: partTitle,
        gameName: job.chapterName,
        part: currentPartNum,
        totalParts,
      });

      result = await uploadVideo(tenantId, config.displayName || tenantId, splitPaths[i], partTitle, job.description, 'public', onUploadProgress);

      const createdGameRecord = await db.game.create({
        data: {
          vod_id: dbId,
          start_time: startTime + chapterStart,
          end_time: endTime + chapterStart,
          video_provider: 'youtube',
          video_id: result.videoId,
          thumbnail_url: result.thumbnailUrl || null,
          game_id: chapterGameId || null,
          game_name: job.chapterName,
          title: job.chapterName,
        },
      });

      uploadedGameVideos.push({
        id: result.videoId,
        part: currentPartNum,
        startTime,
        endTime,
        gameId: String(createdGameRecord.id),
      });
    } catch (error) {
      throw error;
    }

    if (!config.settings.saveMP4) {
      await deleteFile(splitPaths[i]);
    }
  }

  // Update splitting alert on completion
  if (splitAlertMessageId && isAlertsEnabled()) {
    updateDiscordEmbed(splitAlertMessageId, {
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
  }

  resetFailures(tenantId);

  return { success: true, videos: uploadedGameVideos };
}

// ============== Helper Functions ==============

function getEffectiveSplitDuration(splitDuration: number): number {
  if (!splitDuration || splitDuration <= 0) return YOUTUBE_MAX_DURATION;
  if (splitDuration > YOUTUBE_MAX_DURATION) return YOUTUBE_MAX_DURATION;
  return splitDuration;
}

function formatVodDate(createdAt: Date, config: { settings?: { timezone?: string } }): string {
  return dayjs(createdAt)
    .tz(config.settings?.timezone || 'UTC')
    .format('MMMM DD YYYY')
    .toUpperCase();
}

export default youtubeProcessor;
