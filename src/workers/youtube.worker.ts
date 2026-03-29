import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

import type { YoutubeUploadJob } from '../jobs/queues.js';
import { getStreamerConfig } from '../config/loader.js';
import { getClient, createClient } from '../db/client.js';
import { splitVideo, trimVideo, getDuration, deleteFile } from '../utils/ffmpeg.js';
import { uploadVideo, linkParts } from '../services/youtube.js';
import { sendDiscordAlert, updateDiscordMessage, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';

const youtubeProcessor: Processor<YoutubeUploadJob> = async (job: Job<YoutubeUploadJob>) => {
  const { streamerId, vodId, filePath, title, description, type, part, chapter } = job.data;

  // Create logger with tenant context ONCE at start of processing scope
  const log = createAutoLogger({
    tenantId: String(streamerId),
    component: 'YouTube-Worker',
  });

  const config = getStreamerConfig(streamerId);

  if (!config?.youtube) {
    throw new Error('YouTube not configured for streamer');
  }

  let db = getClient(streamerId);
  if (!db) {
    db = await createClient(config);
  }

  const messageId = isAlertsEnabled() ? await sendDiscordAlert(`[${type === 'vod' ? 'VOD Upload' : 'Game Upload'}] ${streamerId} Starting...`) : null;

  try {
    const privacyStatus = config.youtube.public ? 'public' : 'unlisted';
    const splitDuration = config.youtube.splitDuration;

    if (type === 'vod') {
      const duration = await getDuration(filePath);
      const needsSplitting = duration > splitDuration;

      const uploadedVideos: Array<{ id: string; part: number }> = [];

      if (needsSplitting) {
        const parts = await splitVideo(filePath, duration, splitDuration, vodId, (percent: any) => {
          if (messageId && isAlertsEnabled()) {
            updateDiscordMessage(messageId, formatProgressMessage('VOD Splitting', streamerId, percent));
          }
        });

        for (let i = 0; i < parts.length; i++) {
          const partTitle = `${title} - Part ${i + 1}`;
          const result = await uploadVideo(streamerId, parts[i], partTitle, description, privacyStatus);

          uploadedVideos.push({ id: result.videoId, part: i + 1 });

          if (!config.settings.saveMP4) {
            await deleteFile(parts[i]);
          }
        }
      } else {
        const result = await uploadVideo(streamerId, filePath, title, description, privacyStatus);

        uploadedVideos.push({ id: result.videoId, part: 1 });

        if (!config.settings.saveMP4) {
          await deleteFile(filePath);
        }
      }

      for (const video of uploadedVideos) {
        await db.vodUpload.create({
          data: {
            vod_id: vodId,
            upload_id: video.id,
            platform: 'youtube',
            type: 'vod',
            part: video.part,
            status: 'COMPLETED',
          },
        });
      }

      if (uploadedVideos.length > 1) {
        setTimeout(() => linkParts(streamerId, uploadedVideos), 60000);
      }

      resetFailures(streamerId);

      if (messageId && isAlertsEnabled()) {
        await updateDiscordMessage(messageId, `[VOD Upload] ${streamerId} Complete!`);
      }

      return { success: true, videos: uploadedVideos };
    } else {
      const hasTwitch = config.twitch?.enabled === true;
      const hasKick = config.kick?.enabled === true;

      if (hasTwitch && hasKick) {
        const isMainPlatform = job.data.platform === 'twitch' ? config.twitch?.mainPlatform : config.kick?.mainPlatform;

        if (!isMainPlatform) {
          log.info(`[${vodId}] Skipping game upload: ${job.data.platform} is not main platform (simulcast mode)`);

          await db.game.updateMany({
            where: { vod_id: vodId },
            data: { video_provider: null, video_id: null, thumbnail_url: null },
          });

          resetFailures(streamerId);

          if (messageId && isAlertsEnabled()) {
            await updateDiscordMessage(messageId, `[Game Upload] ${streamerId} Skipped (${job.data.platform} not main platform)`);
          }

          return { success: true, skipped: true };
        }
      }
      const trimmedPath = await trimVideo(filePath, chapter!.start, chapter!.end, `${vodId}-${part}`, (percent: any) => {
        if (messageId && isAlertsEnabled()) {
          updateDiscordMessage(messageId, formatProgressMessage('Game Trimming', streamerId, percent));
        }
      });

      await getDuration(trimmedPath);
      const dateStr = dayjs().tz(config?.settings?.timezone).format('MMMM DD YYYY');

      const gameTitle = `${title} EP ${part} - ${dateStr}`;

      const result = await uploadVideo(streamerId, trimmedPath, gameTitle, config.youtube.description || '', privacyStatus);

      await db.game.updateMany({
        where: { vod_id: vodId },
        data: { video_id: result.videoId, thumbnail_url: result.thumbnailUrl },
      });

      await deleteFile(trimmedPath);

      resetFailures(streamerId);

      if (messageId && isAlertsEnabled()) {
        await updateDiscordMessage(messageId, `[Game Upload] ${streamerId} Complete!`);
      }

      return { success: true, videoId: result.videoId };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error(
      {
        vodId,
        streamerId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      `YouTube upload failed for ${vodId}`
    );

    await db?.vodUpload.updateMany({
      where: { vod_id: vodId },
      data: { status: 'FAILED' },
    });

    if (messageId && isAlertsEnabled()) {
      await updateDiscordMessage(messageId, `[YouTube Upload] ${streamerId} FAILED: ${(error as Error).message}`);
    }

    throw error;
  }
};

export default youtubeProcessor;
