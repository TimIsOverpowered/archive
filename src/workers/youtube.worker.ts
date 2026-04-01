import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

import type { YoutubeUploadJob, YoutubeUploadResult } from '../jobs/queues.js';
import { getStreamerConfig } from '../config/loader.js';
import { getClient, createClient } from '../db/client.js';
import { splitVideo, trimVideo, getDuration, deleteFile } from '../utils/ffmpeg.js';
import { uploadVideo, linkParts } from '../services/youtube.js';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { toHHMMSS } from '../utils/formatting.js';

type ExtendedYoutubeUploadJob = YoutubeUploadJob & { dmcaProcessed?: boolean };

const YOUTUBE_MAX_DURATION = 43199; // YouTube hard limit: 12 hours - 1 second (720 minutes)

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { streamerId, vodId, filePath, type, part, chapter } = job.data;

  const log = createAutoLogger(String(streamerId));

  const config = getStreamerConfig(streamerId);

  if (!config?.youtube) {
    throw new Error('YouTube not configured for streamer');
  }

  let db = getClient(streamerId);
  if (!db) {
    db = await createClient(config);
  }

  const messageId = isAlertsEnabled()
    ? await sendRichAlert({
        title: `📺 ${type === 'vod' ? 'VOD Upload' : 'Game Upload'} Started`,
        description: `${streamerId} - Processing video for YouTube upload`,
        status: 'warning',
        fields: [
          { name: 'Type', value: type, inline: true },
          { name: 'Streamer ID', value: streamerId, inline: false },
        ],
        timestamp: new Date().toISOString(),
      })
    : null;

  try {
    const privacyStatus = config.youtube.public ? 'public' : 'unlisted';
    const splitDuration = config.youtube.splitDuration;

    if (type === 'vod') {
      const vodRecord = await db.vod.findUnique({ where: { id: vodId } });

      if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

      const platformName = vodRecord.platform.charAt(0).toUpperCase() + vodRecord.platform.slice(1);
      const channelName = config.displayName || streamerId;
      const dateFormatted = dayjs(vodRecord.created_at)
        .tz(config.settings?.timezone || 'UTC')
        .format('MMMM DD YYYY')
        .toUpperCase();

      const duration = (await getDuration(filePath)) ?? 0;

      const extendedData = job.data as ExtendedYoutubeUploadJob;

      let effectiveSplitDuration: number;

      if (!splitDuration || splitDuration <= 0) {
        effectiveSplitDuration = YOUTUBE_MAX_DURATION;
      } else if (splitDuration > YOUTUBE_MAX_DURATION) {
        log.warn({ configured: splitDuration, capped: YOUTUBE_MAX_DURATION }, 'YouTube splitDuration exceeds max limit, capping to YouTube maximum');
        effectiveSplitDuration = YOUTUBE_MAX_DURATION;
      } else {
        effectiveSplitDuration = splitDuration;
      }

      const exceedsYouTubeMax = duration > YOUTUBE_MAX_DURATION;
      const exceedsUserLimit = !extendedData.dmcaProcessed && duration > effectiveSplitDuration;
      const needsSplitting = exceedsYouTubeMax || exceedsUserLimit;

      const uploadedVideos: Array<{ id: string; part: number }> = [];

      if (needsSplitting) {
        const totalParts = Math.ceil(duration / effectiveSplitDuration);

        // Create splitting progress alert
        let splitAlertMessageId: string | null = null;
        if (isAlertsEnabled()) {
          splitAlertMessageId = await sendRichAlert({
            title: `📺 VOD Splitting in Progress`,
            description: `${streamerId} - Preparing ${totalParts} parts...`,
            status: 'warning',
            fields: [
              { name: 'VOD ID', value: vodId, inline: true },
              { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
              { name: 'Parts Count', value: String(totalParts), inline: false },
            ],
            timestamp: new Date().toISOString(),
          });
        }

        const parts = await splitVideo(filePath, duration, effectiveSplitDuration, vodId, (percent: number) => {
          if (splitAlertMessageId && isAlertsEnabled()) {
            updateDiscordEmbed(splitAlertMessageId, {
              title: `📺 Splitting VOD`,
              description: `${streamerId} - Preparing video parts for upload`,
              status: 'warning',
              fields: [{ name: 'Progress', value: formatProgressMessage('VOD Splitting', streamerId, percent), inline: false }],
              timestamp: new Date().toISOString(),
              updatedTimestamp: new Date().toISOString(),
            });
          }
        });

        for (let i = 0; i < parts.length; i++) {
          const currentPartNum = i + 1;

          // Create individual upload progress alert per part
          let uploadAlertMessageId: string | null = null;
          if (isAlertsEnabled()) {
            uploadAlertMessageId = await sendRichAlert({
              title: `📺 YouTube Upload (Part ${currentPartNum}/${totalParts})`,
              description: `${streamerId} - Uploading video part to YouTube...`,
              status: 'warning',
              fields: [
                { name: 'VOD ID', value: vodId, inline: true },
                { name: 'Platform', value: platformName.toUpperCase(), inline: true },
                { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
              ],
              timestamp: new Date().toISOString(),
            });
          }

          const partTitle = `${channelName} ${platformName} VOD - ${dateFormatted} PART ${i + 1}`;

          const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
          const domainName = config.settings?.domainName || 'localhost';
          const legacyDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

          let result;
          try {
            result = await uploadVideo(streamerId, parts[i], partTitle, legacyDescription, privacyStatus);

            uploadedVideos.push({ id: result.videoId, part: i + 1 });

            // Update alert on success
            if (uploadAlertMessageId && isAlertsEnabled()) {
              updateDiscordEmbed(uploadAlertMessageId, {
                title: `✅ Upload Complete (Part ${currentPartNum}/${totalParts})`,
                description: `${streamerId} - Successfully uploaded to YouTube!`,
                status: 'success',
                fields: [
                  { name: 'YouTube Video ID', value: result.videoId.substring(0, 12) + '...', inline: false },
                  { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
                ],
                timestamp: new Date().toISOString(),
                updatedTimestamp: new Date().toISOString(),
              });
            }
          } catch (error) {
            // Update alert on failure
            if (uploadAlertMessageId && isAlertsEnabled()) {
              const errorDetails = extractErrorDetails(error);
              updateDiscordEmbed(uploadAlertMessageId, {
                title: `❌ Upload Failed (Part ${currentPartNum}/${totalParts})`,
                description: `${streamerId} - Video upload encountered an error`,
                status: 'error',
                fields: [
                  { name: 'Error', value: errorDetails.message.substring(0, 500), inline: false },
                  { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
                ],
                timestamp: new Date().toISOString(),
                updatedTimestamp: new Date().toISOString(),
              });
            }

            throw error; // Re-throw to trigger retry mechanism
          }

          if (!config.settings.saveMP4) {
            await deleteFile(parts[i]);
          }
        }

        // Update splitting alert on completion
        if (splitAlertMessageId && isAlertsEnabled()) {
          updateDiscordEmbed(splitAlertMessageId, {
            title: `✅ VOD Splitting Complete`,
            description: `${streamerId} - Successfully split into ${totalParts} parts`,
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
        const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
        const domainName = config.settings?.domainName || 'localhost';
        const legacyDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

        const vodTitle = `${channelName} ${platformName} VOD - ${dateFormatted}`;

        const result = await uploadVideo(streamerId, filePath, vodTitle, legacyDescription, privacyStatus);

        uploadedVideos.push({ id: result.videoId, part: 1 });

        if (!config.settings.saveMP4 || extendedData.dmcaProcessed === true) {
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
        setTimeout(() => {
          void linkParts(streamerId, uploadedVideos);
        }, 60000);
      }

      resetFailures(streamerId);

      if (messageId && isAlertsEnabled()) {
        updateDiscordEmbed(messageId, {
          title: `[YouTube] Vod Upload Complete`,
          description: `${streamerId} - Successfully uploaded to YouTube`,
          status: 'success',
          fields: [{ name: 'Type', value: type, inline: true }],
          timestamp: new Date().toISOString(),
          updatedTimestamp: new Date().toISOString(),
        });
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
            updateDiscordEmbed(messageId, {
              title: `⏭️ Game Upload Skipped`,
              description: `${streamerId} - ${job.data.platform?.toUpperCase() || 'UNKNOWN'} not main platform in simulcast mode`,
              status: 'warning',
              fields: [{ name: 'Platform', value: job.data.platform || 'unknown', inline: true }],
              timestamp: new Date().toISOString(),
              updatedTimestamp: new Date().toISOString(),
            });
          }

          return { success: true, skipped: true };
        }
      }
      if (!chapter) throw new Error('Chapter data required for game upload type');

      const vodRecord = await db.vod.findUnique({ where: { id: vodId } });

      if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

      const channelName = config.displayName || streamerId;
      const dateFormatted = dayjs(vodRecord.created_at)
        .tz(config.settings?.timezone || 'UTC')
        .format('MMMM DD YYYY')
        .toUpperCase();

      let totalGames: number | undefined;

      try {
        const gameCountResult = await db.game.count({
          where: {
            game_name: chapter.name,
            vod_id: { not: vodId }, // Exclude current VOD from count
          },
        });
        totalGames = gameCountResult;
      } catch {
        log.warn(`Failed to count previous games for ${chapter.name}, using title without EP number`);
      }

      const trimmedPath = await trimVideo(filePath, chapter.start, chapter.end, `${vodId}-${part}`, (percent: number) => {
        if (messageId && isAlertsEnabled()) {
          updateDiscordEmbed(messageId, {
            title: `✂️ Trimming Game Clip`,
            description: `${streamerId} - Extracting game segment from video`,
            status: 'warning',
            fields: [{ name: 'Progress', value: formatProgressMessage('Game Trimming', streamerId, percent), inline: false }],
            timestamp: new Date().toISOString(),
            updatedTimestamp: new Date().toISOString(),
          });
        }
      });

      const trimmedDuration = (await getDuration(trimmedPath)) ?? 0;

      const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
      const domainName = config.settings?.domainName || 'localhost';

      const gameExceedsYoutubeMax = trimmedDuration > YOUTUBE_MAX_DURATION;

      if (gameExceedsYoutubeMax) {
        log.info({ duration: trimmedDuration, parts: Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION) }, `Game clip exceeds YouTube max duration, auto-splitting`);

        const totalParts = Math.ceil(trimmedDuration / YOUTUBE_MAX_DURATION);

        // Create splitting progress alert for game clips
        let splitAlertMessageId: string | null = null;
        if (isAlertsEnabled()) {
          splitAlertMessageId = await sendRichAlert({
            title: `✂️ Game Clip Splitting in Progress`,
            description: `${streamerId} - Preparing ${totalParts} parts...`,
            status: 'warning',
            fields: [
              { name: 'Game Name', value: chapter.name, inline: true },
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
              description: `${streamerId} - Game clip exceeds YouTube max duration`,
              status: 'warning',
              fields: [{ name: 'Progress', value: formatProgressMessage('Game Splitting', streamerId, percent), inline: false }],
              timestamp: new Date().toISOString(),
              updatedTimestamp: new Date().toISOString(),
            });
          }
        });

        const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId?: number }> = [];

        for (let i = 0; i < totalParts; i++) {
          const currentPartNum = i + 1;
          const startTime = i * YOUTUBE_MAX_DURATION;
          const endTime = Math.min(startTime + YOUTUBE_MAX_DURATION, trimmedDuration);

          let ytTitle = '';

          if (totalGames !== undefined) {
            const epNumber = totalGames + 1;

            if (currentPartNum > 1) {
              ytTitle = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted} PART ${currentPartNum}`;
            } else {
              ytTitle = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted}`;
            }
          } else {
            if (currentPartNum > 1) {
              ytTitle = `${channelName} plays ${chapter.name} - ${dateFormatted} PART ${currentPartNum}`;
            } else {
              ytTitle = `${channelName} plays ${chapter.name} - ${dateFormatted}`;
            }
          }

          const legacyDescription = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

          // Create individual upload progress alert per game part
          let uploadAlertMessageId: string | null = null;
          if (isAlertsEnabled()) {
            uploadAlertMessageId = await sendRichAlert({
              title: `🎮 Game Upload (Part ${currentPartNum}/${totalParts})`,
              description: `${streamerId} - Uploading game clip part to YouTube...`,
              status: 'warning',
              fields: [
                { name: 'Game Name', value: chapter.name, inline: true },
                { name: 'VOD ID', value: vodId, inline: true },
                { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
              ],
              timestamp: new Date().toISOString(),
            });
          }

          let result;
          try {
            result = await uploadVideo(streamerId, splitPaths[i], ytTitle, legacyDescription, 'public');

            const createdGameRecord = await db.game.create({
              data: {
                vod_id: vodId,
                start_time: (startTime + chapter.start).toString(),
                end_time: (endTime + chapter.start).toString(),
                video_provider: 'youtube',
                video_id: result.videoId,
                thumbnail_url: result.thumbnailUrl || null,
                game_id: chapter.gameId || null,
                game_name: chapter.name,
                title: `${chapter.name} EP ${totalGames !== undefined ? totalGames + 1 : ''}`.trim(),
              },
            });

            uploadedGameVideos.push({
              id: result.videoId,
              part: currentPartNum,
              startTime,
              endTime,
              gameId: createdGameRecord.id,
            });

            // Update alert on success
            if (uploadAlertMessageId && isAlertsEnabled()) {
              updateDiscordEmbed(uploadAlertMessageId, {
                title: `✅ Game Upload Complete (Part ${currentPartNum}/${totalParts})`,
                description: `${streamerId} - Successfully uploaded to YouTube!`,
                status: 'success',
                fields: [
                  { name: 'YouTube Video ID', value: result.videoId.substring(0, 12) + '...', inline: false },
                  { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
                ],
                timestamp: new Date().toISOString(),
                updatedTimestamp: new Date().toISOString(),
              });
            }
          } catch (error) {
            // Update alert on failure
            if (uploadAlertMessageId && isAlertsEnabled()) {
              const errorDetails = extractErrorDetails(error);
              updateDiscordEmbed(uploadAlertMessageId, {
                title: `❌ Game Upload Failed (Part ${currentPartNum}/${totalParts})`,
                description: `${streamerId} - Video upload encountered an error`,
                status: 'error',
                fields: [
                  { name: 'Error', value: errorDetails.message.substring(0, 500), inline: false },
                  { name: 'Part', value: `${currentPartNum} of ${totalParts}`, inline: false },
                ],
                timestamp: new Date().toISOString(),
                updatedTimestamp: new Date().toISOString(),
              });
            }

            throw error; // Re-throw to trigger retry mechanism
          }

          if (!config.settings.saveMP4) {
            await deleteFile(splitPaths[i]);
          }
        }

        // Update splitting alert on completion
        if (splitAlertMessageId && isAlertsEnabled()) {
          updateDiscordEmbed(splitAlertMessageId, {
            title: `✅ Game Clip Splitting Complete`,
            description: `${streamerId} - Successfully split into ${totalParts} parts`,
            status: 'success',
            fields: [
              { name: 'Total Duration', value: toHHMMSS(trimmedDuration), inline: true },
              { name: 'Parts Count', value: String(totalParts), inline: false },
            ],
            timestamp: new Date().toISOString(),
            updatedTimestamp: new Date().toISOString(),
          });
        }

        resetFailures(streamerId);

        if (messageId && isAlertsEnabled()) {
          updateDiscordEmbed(messageId, {
            title: `[YouTube] Game Upload Complete`,
            description: `${streamerId} - Successfully uploaded ${totalParts} parts to YouTube`,
            status: 'success',
            fields: [{ name: 'Type', value: type, inline: true }],
            timestamp: new Date().toISOString(),
            updatedTimestamp: new Date().toISOString(),
          });
        }

        return { success: true, videos: uploadedGameVideos };
      } else {
        let ytTitle = '';

        if (totalGames !== undefined) {
          const epNumber = totalGames + 1;

          if (part && part > 1) {
            ytTitle = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted} PART ${part}`;
          } else {
            ytTitle = `${channelName} plays ${chapter.name} EP ${epNumber} - ${dateFormatted}`;
          }
        } else {
          if (part && part > 1) {
            ytTitle = `${channelName} plays ${chapter.name} - ${dateFormatted} PART ${part}`;
          } else {
            ytTitle = `${channelName} plays ${chapter.name} - ${dateFormatted}`;
          }
        }

        const legacyDescription = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

        const result = await uploadVideo(streamerId, trimmedPath, ytTitle, legacyDescription, 'public');

        const createdGameRecord = await db.game.create({
          data: {
            vod_id: vodId,
            start_time: chapter.start.toString(),
            end_time: chapter.end.toString(),
            video_provider: 'youtube',
            video_id: result.videoId,
            thumbnail_url: result.thumbnailUrl || null,
            game_id: chapter.gameId || null,
            game_name: chapter.name,
            title: `${chapter.name} EP ${totalGames !== undefined ? totalGames + 1 : ''}`.trim(),
          },
        });

        await deleteFile(trimmedPath);

        resetFailures(streamerId);

        if (messageId && isAlertsEnabled()) {
          updateDiscordEmbed(messageId, {
            title: `[YouTube] Game Upload Complete`,
            description: `${streamerId} - Successfully uploaded to YouTube`,
            status: 'success',
            fields: [{ name: 'Type', value: type, inline: true }],
            timestamp: new Date().toISOString(),
            updatedTimestamp: new Date().toISOString(),
          });
        }

        return { success: true, videoId: result.videoId, gameId: createdGameRecord.id };
      }
    }
  } catch (error) {
    const details = extractErrorDetails(error);

    log.error(
      {
        ...details,
        vodId,
        streamerId,
      },
      `YouTube upload failed for ${vodId}`
    );

    await db.vodUpload.updateMany({
      where: { vod_id: vodId },
      data: { status: 'FAILED' },
    });

    if (messageId && isAlertsEnabled()) {
      updateDiscordEmbed(messageId, {
        title: `[YouTube] Upload Failed`,
        description: `${streamerId} - Video upload encountered an error`,
        status: 'error',
        fields: [
          { name: 'Type', value: type, inline: true },
          { name: 'Error', value: details.message.substring(0, 500), inline: false },
        ],
        timestamp: new Date().toISOString(),
        updatedTimestamp: new Date().toISOString(),
      });
    }

    throw error;
  }
};

export default youtubeProcessor;
