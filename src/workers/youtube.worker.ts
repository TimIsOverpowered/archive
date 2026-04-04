import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

import type { YoutubeUploadJob, YoutubeUploadResult } from '../jobs/queues.js';
import { getTenantConfig } from '../config/loader.js';
import { getClient, createClient } from '../db/client.js';
import { splitVideo, trimVideo, getDuration, deleteFile } from '../utils/ffmpeg.js';
import { uploadVideo, linkParts } from '../services/youtube.js';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
import { createAutoLogger } from '../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { toHHMMSS } from '../utils/formatting.js';
import { createYoutubeUploadProgressHandler } from '../utils/youtube-upload-progress.js';

type ExtendedYoutubeUploadJob = YoutubeUploadJob & { dmcaProcessed?: boolean };

const YOUTUBE_MAX_DURATION = 43199; // YouTube hard limit: 12 hours - 1 second (720 minutes)

const youtubeProcessor: Processor<YoutubeUploadJob, YoutubeUploadResult> = async (job: Job<YoutubeUploadJob>) => {
  const { tenantId, vodId, filePath, type, part, chapter } = job.data;

  const log = createAutoLogger(String(tenantId));

  const config = getTenantConfig(tenantId);

  if (!config?.youtube) {
    throw new Error('YouTube not configured for streamer');
  }

  let db = getClient(tenantId);
  if (!db) {
    db = await createClient(config);
  }

  try {
    const privacyStatus = config.youtube.public ? 'public' : 'unlisted';
    const splitDuration = config.youtube.splitDuration;

    if (type === 'vod') {
      const vodRecord = await db.vod.findUnique({ where: { id: vodId } });

      if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

      const platformName = vodRecord.platform.charAt(0).toUpperCase() + vodRecord.platform.slice(1);
      const channelName = config.displayName || tenantId;
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

        const parts = await splitVideo(filePath, duration, effectiveSplitDuration, vodId, (percent: number) => {
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

          // Create individual upload progress alert per part
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

          const partTitle = `${channelName} ${platformName} VOD - ${dateFormatted} PART ${i + 1}`;

          const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
          const domainName = config.settings?.domainName || 'localhost';
          const youtubeDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

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
            // Error already handled in progress callback above - just re-throw for retry mechanism
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
        const vodStreamTitle = vodRecord.title ? vodRecord.title.replace(/>|</gi, '') : '';
        const domainName = config.settings?.domainName || 'localhost';
        const youtubeDescription = `Chat Replay: https://${domainName}/youtube/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

        const vodTitle = `${channelName} ${platformName} VOD - ${dateFormatted}`;

        // Send initial upload alert for single-part uploads
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
          void linkParts(tenantId, uploadedVideos);
        }, 60000);
      }

      resetFailures(tenantId);

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

          resetFailures(tenantId);

          return { success: true, skipped: true };
        }
      }
      if (!chapter) throw new Error('Chapter data required for game upload type');

      const vodRecord = await db.vod.findUnique({ where: { id: vodId } });

      if (!vodRecord) throw new Error(`VOD record not found for ${vodId}`);

      const channelName = config.displayName || tenantId;
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

      const trimmedPath = await trimVideo(filePath, chapter.start, chapter.end, `${vodId}-${part}`); // No progress callback needed - trimming is fast

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
            description: `${tenantId} - Preparing ${totalParts} parts...`,
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
              description: `${tenantId} - Game clip exceeds YouTube max duration`,
              status: 'warning',
              fields: [{ name: 'Progress', value: formatProgressMessage('Game Splitting', tenantId, percent), inline: false }],
              timestamp: new Date().toISOString(),
              updatedTimestamp: new Date().toISOString(),
            });
          }
        });

        const uploadedGameVideos: Array<{ id: string; part: number; startTime: number; endTime: number; gameId?: string }> = [];

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

          const youtubeDescription = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

          // Create individual upload progress alert per game part
          let uploadAlertMessageId: string | null = null;
          if (isAlertsEnabled()) {
            uploadAlertMessageId = await sendRichAlert({
              title: `🎮 Game Upload (Part ${currentPartNum}/${totalParts})`,
              description: `${tenantId} - Uploading game clip part to YouTube...`,
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
            const onUploadProgress = createYoutubeUploadProgressHandler({
              messageId: uploadAlertMessageId,
              type: 'game',
              channelName,
              videoTitle: ytTitle,
              gameName: chapter.name,
              part: currentPartNum,
              totalParts,
            });

            result = await uploadVideo(tenantId, channelName, splitPaths[i], ytTitle, youtubeDescription, 'public', onUploadProgress);

            const createdGameRecord = await db.game.create({
              data: {
                vod_id: vodId,
                start_time: startTime + chapter.start,
                end_time: endTime + chapter.start,
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
              gameId: String(createdGameRecord.id),
            });
          } catch (error) {
            // Error already handled in progress callback above - just re-throw for retry mechanism
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

        const youtubeDescription = `Chat Replay: https://${domainName}/games/${vodId}\nStream Title: ${vodStreamTitle}\n${config.youtube.description || ''}`;

        // Send initial upload alert for single game uploads (non-split)
        let uploadAlertMessageId: string | null = null;
        if (isAlertsEnabled()) {
          uploadAlertMessageId = await sendRichAlert({
            title: `🎮 Game Upload Started`,
            description: `${tenantId} - Uploading game clip to YouTube...`,
            status: 'warning',
            fields: [
              { name: 'Game Name', value: chapter.name, inline: true },
              { name: 'VOD ID', value: vodId, inline: false },
            ],
            timestamp: new Date().toISOString(),
          });
        }

        const result = await uploadVideo(
          tenantId,
          channelName,
          trimmedPath,
          ytTitle,
          youtubeDescription,
          'public',
          createYoutubeUploadProgressHandler({
            messageId: uploadAlertMessageId,
            type: 'game',
            channelName,
            gameName: chapter.name,
          })
        );

        const createdGameRecord = await db.game.create({
          data: {
            vod_id: vodId,
            start_time: chapter.start,
            end_time: chapter.end,
            video_provider: 'youtube',
            video_id: result.videoId,
            thumbnail_url: result.thumbnailUrl || null,
            game_id: chapter.gameId || null,
            game_name: chapter.name,
            title: `${chapter.name} EP ${totalGames !== undefined ? totalGames + 1 : ''}`.trim(),
          },
        });

        await deleteFile(trimmedPath);

        resetFailures(tenantId);

        return { success: true, videoId: result.videoId, gameId: String(createdGameRecord.id) };
      }
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
      where: { vod_id: vodId },
      data: { status: 'FAILED' },
    });

    throw error; // Error details already logged above - individual upload callbacks handle Discord notifications for their specific uploads
  }
};

export default youtubeProcessor;
