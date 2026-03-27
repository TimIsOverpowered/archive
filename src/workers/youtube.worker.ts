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

const youtubeProcessor: Processor<YoutubeUploadJob> = async (job: Job<YoutubeUploadJob>) => {
  const { streamerId, vodId, filePath, title, description, type, part, chapter } = job.data;

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

          if (!config.youtube.saveMP4) {
            await deleteFile(parts[i]);
          }
        }
      } else {
        const result = await uploadVideo(streamerId, filePath, title, description, privacyStatus);

        uploadedVideos.push({ id: result.videoId, part: 1 });

        if (!config.youtube.saveMP4) {
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
      const trimmedPath = await trimVideo(filePath, chapter!.start, chapter!.end, `${vodId}-${part}`, (percent: any) => {
        if (messageId && isAlertsEnabled()) {
          updateDiscordMessage(messageId, formatProgressMessage('Game Trimming', streamerId, percent));
        }
      });

      await getDuration(trimmedPath);
      const dateStr = dayjs().tz(config.timezone).format('MMM D, YYYY');

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
    console.error(`YouTube upload failed for ${vodId}:`, error);

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
