import { Processor, Job } from 'bullmq';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(timezone);

import type { YoutubeUploadJob, YoutubeUploadResult } from '../jobs/queues.js';
import { getStreamerConfig } from '../config/loader.js';
import { getClient, createClient } from '../db/client.js';
import { splitVideo, trimVideo, getDuration, deleteFile } from '../utils/ffmpeg.js';
import { uploadVideo, linkParts, type UploadProgressCallbackData } from '../services/youtube.js';
import { sendRichAlert, updateDiscordEmbed, formatProgressMessage, resetFailures, isAlertsEnabled } from '../utils/discord-alerts.js';
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
            // Progress callback for Discord milestone updates with part context
            const onUploadProgress = async (progress: UploadProgressCallbackData) => {
              if (!uploadAlertMessageId || !isAlertsEnabled()) return;

              switch (progress.milestone) {
                case 'starting':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `📺 Uploading Part ${currentPartNum}/${totalParts}`,
                    description: `${channelName} - Initializing upload stream...`,
                    status: 'warning',
                    fields: [
                      { name: 'Video', value: partTitle.substring(0, 150), inline: false },
                      { name: 'Part', value: `${currentPartNum}/${totalParts}`, inline: true },
                    ],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'processing_metadata':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `🔄 Processing Part ${currentPartNum}/${totalParts}`,
                    description: `${channelName} - Fetching video metadata & thumbnails...`,
                    status: 'warning',
                    fields: [
                      { name: 'Video ID', value: progress.videoId || '', inline: false },
                      { name: 'Part', value: `${currentPartNum}/${totalParts}`, inline: true },
                    ],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'success':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `✅ Upload Complete (Part ${currentPartNum}/${totalParts})`,
                    description: `${channelName} - Successfully uploaded to YouTube!`,
                    status: 'success',
                    fields: [
                      { name: '', value: progress.thumbnailUrl || '' }, // Auto-expand thumbnail image in Discord
                      { name: 'Video ID', value: (progress.videoId || '').substring(0, 12) + '...', inline: false },
                      { name: 'Part', value: `${currentPartNum}/${totalParts}`, inline: true },
                    ],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'error':
                  if (progress.errorDetails) {
                    const errorMsg = extractErrorDetails(progress.errorDetails).message;
                    await updateDiscordEmbed(uploadAlertMessageId, {
                      title: `❌ Upload Failed (Part ${currentPartNum}/${totalParts})`,
                      description: `${channelName} - Video upload encountered an error`,
                      status: 'error',
                      fields: [
                        { name: 'Error', value: errorMsg.substring(0, 500), inline: false },
                        { name: 'Part', value: `${currentPartNum}/${totalParts}`, inline: true },
                      ],
                      timestamp: new Date().toISOString(),
                    });
                  }
              }
            };

            result = await uploadVideo(streamerId, channelName, parts[i], partTitle, legacyDescription, privacyStatus, onUploadProgress);

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

        // Send initial upload alert for single-part uploads
        let uploadAlertMessageId: string | null = null;
        if (isAlertsEnabled()) {
          uploadAlertMessageId = await sendRichAlert({
            title: `📺 YouTube Upload Started`,
            description: `${streamerId} - Uploading VOD to YouTube...`,
            status: 'warning',
            fields: [
              { name: 'VOD ID', value: vodId, inline: true },
              { name: 'Platform', value: platformName.toUpperCase(), inline: true },
            ],
            timestamp: new Date().toISOString(),
          });
        }

        const result = await uploadVideo(
          streamerId,
          channelName,
          filePath,
          vodTitle,
          legacyDescription,
          privacyStatus,
          // Progress callback for Discord milestone updates
          async (progress: UploadProgressCallbackData) => {
            if (!uploadAlertMessageId || !isAlertsEnabled()) return;

            switch (progress.milestone) {
              case 'starting':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `📺 Uploading VOD`,
                  description: `${channelName} - Initializing upload stream...`,
                  status: 'warning',
                  fields: [{ name: 'Video', value: vodTitle.substring(0, 150), inline: false }],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'processing_metadata':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `🔄 Processing VOD`,
                  description: `${channelName} - Fetching video metadata & thumbnails...`,
                  status: 'warning',
                  fields: [{ name: 'Video ID', value: progress.videoId || '', inline: false }],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'success':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `✅ VOD Upload Complete`,
                  description: `${channelName} - Successfully uploaded to YouTube!`,
                  status: 'success',
                  fields: [
                    { name: '', value: progress.thumbnailUrl || '' }, // Auto-expand thumbnail image in Discord
                    { name: 'Video ID', value: (progress.videoId || '').substring(0, 12) + '...', inline: false },
                  ],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'error':
                if (progress.errorDetails) {
                  const errorMsg = extractErrorDetails(progress.errorDetails).message;
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `❌ VOD Upload Failed`,
                    description: `${channelName} - Video upload encountered an error`,
                    status: 'error',
                    fields: [{ name: 'Error', value: errorMsg.substring(0, 500), inline: false }],
                    timestamp: new Date().toISOString(),
                  });
                }
            }
          }
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
          void linkParts(streamerId, uploadedVideos);
        }, 60000);
      }

      resetFailures(streamerId);

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
            // Progress callback for Discord milestone updates with game context
            const onUploadProgress = async (progress: UploadProgressCallbackData) => {
              if (!uploadAlertMessageId || !isAlertsEnabled()) return;

              switch (progress.milestone) {
                case 'starting':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `🎮 Uploading Part ${currentPartNum}/${totalParts}`,
                    description: `${channelName} - Initializing upload stream...`,
                    status: 'warning',
                    fields: [
                      { name: 'Game', value: chapter.name.substring(0, 150), inline: true },
                      { name: 'Video', value: ytTitle.substring(0, 100), inline: false },
                    ],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'processing_metadata':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `🔄 Processing Part ${currentPartNum}/${totalParts}`,
                    description: `${channelName} - Fetching video metadata & thumbnails...`,
                    status: 'warning',
                    fields: [{ name: 'Video ID', value: progress.videoId || '', inline: false }],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'success':
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `✅ Game Upload Complete (Part ${currentPartNum}/${totalParts})`,
                    description: `${channelName} - Successfully uploaded to YouTube!`,
                    status: 'success',
                    fields: [
                      { name: '', value: progress.thumbnailUrl || '' }, // Auto-expand thumbnail image in Discord
                      { name: 'Video ID', value: (progress.videoId || '').substring(0, 12) + '...', inline: false },
                    ],
                    timestamp: new Date().toISOString(),
                  });
                  break;

                case 'error':
                  if (progress.errorDetails) {
                    const errorMsg = extractErrorDetails(progress.errorDetails).message;
                    await updateDiscordEmbed(uploadAlertMessageId, {
                      title: `❌ Game Upload Failed`,
                      description: `${channelName} - Video upload encountered an error`,
                      status: 'error',
                      fields: [{ name: 'Error', value: errorMsg.substring(0, 500), inline: false }],
                      timestamp: new Date().toISOString(),
                    });
                  }
              }
            };

            result = await uploadVideo(streamerId, channelName, splitPaths[i], ytTitle, legacyDescription, 'public', onUploadProgress);

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

        // Send initial upload alert for single game uploads (non-split)
        let uploadAlertMessageId: string | null = null;
        if (isAlertsEnabled()) {
          uploadAlertMessageId = await sendRichAlert({
            title: `🎮 Game Upload Started`,
            description: `${streamerId} - Uploading game clip to YouTube...`,
            status: 'warning',
            fields: [
              { name: 'Game Name', value: chapter.name, inline: true },
              { name: 'VOD ID', value: vodId, inline: false },
            ],
            timestamp: new Date().toISOString(),
          });
        }

        const result = await uploadVideo(
          streamerId,
          channelName,
          trimmedPath,
          ytTitle,
          legacyDescription,
          'public',
          // Progress callback for Discord milestone updates
          async (progress: UploadProgressCallbackData) => {
            if (!uploadAlertMessageId || !isAlertsEnabled()) return;

            switch (progress.milestone) {
              case 'starting':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `🎮 Uploading Game Clip`,
                  description: `${channelName} - Initializing upload stream...`,
                  status: 'warning',
                  fields: [{ name: 'Game', value: chapter.name.substring(0, 150), inline: true }],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'processing_metadata':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `🔄 Processing Game Clip`,
                  description: `${channelName} - Fetching video metadata & thumbnails...`,
                  status: 'warning',
                  fields: [{ name: 'Video ID', value: progress.videoId || '', inline: false }],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'success':
                await updateDiscordEmbed(uploadAlertMessageId, {
                  title: `✅ Game Upload Complete`,
                  description: `${channelName} - Successfully uploaded to YouTube!`,
                  status: 'success',
                  fields: [
                    { name: '', value: progress.thumbnailUrl || '' }, // Auto-expand thumbnail image in Discord
                    { name: 'Video ID', value: (progress.videoId || '').substring(0, 12) + '...', inline: false },
                  ],
                  timestamp: new Date().toISOString(),
                });
                break;

              case 'error':
                if (progress.errorDetails) {
                  const errorMsg = extractErrorDetails(progress.errorDetails).message;
                  await updateDiscordEmbed(uploadAlertMessageId, {
                    title: `❌ Game Upload Failed`,
                    description: `${channelName} - Video upload encountered an error`,
                    status: 'error',
                    fields: [{ name: 'Error', value: errorMsg.substring(0, 500), inline: false }],
                    timestamp: new Date().toISOString(),
                  });
                }
            }
          }
        );

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

    throw error; // Error details already logged above - individual upload callbacks handle Discord notifications for their specific uploads
  }
};

export default youtubeProcessor;
