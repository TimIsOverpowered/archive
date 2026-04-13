import type { PrismaClient } from '../../../generated/streamer/client.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';
import { splitVideo, getDuration, deleteFile } from '../vod/ffmpeg.js';
import { uploadVideo, linkParts } from '../../services/youtube/index.js';
import { initRichAlert, updateAlert, formatProgressMessage } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { getEffectiveSplitDuration } from './validation.js';
import { buildYoutubeMetadata } from './metadata-builder.js';
import { createYoutubeUploadProgressHandler as createVodUploadProgressHandler } from './youtube-upload-progress.js';
import type { TenantConfig } from '../../config/types.js';
import type { SourceType } from '../../types/platforms.js';
import { UPLOAD_TYPES } from '../../types/platforms.js';

export interface VodUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath: string;
  db: PrismaClient;
  config: TenantConfig;
  vodRecord: {
    platform: string;
    created_at: Date;
    title: string | null;
  };
  dmcaProcessed?: boolean;
  log: AppLogger;
  type: SourceType;
}

export interface VodUploadResult {
  uploadedVideos: Array<{ id: string; part: number }>;
  needsPartLinking: boolean;
}

export async function processVodUpload(ctx: VodUploadContext): Promise<VodUploadResult> {
  const { tenantId, filePath, config, vodRecord } = ctx;
  const channelName = config.displayName || tenantId;
  const domainName = config.settings?.domainName || 'localhost';
  const privacyStatus = config.youtube!.public ? 'public' : 'unlisted';
  const splitDuration = getEffectiveSplitDuration(config.youtube!.splitDuration);
  const duration = (await getDuration(filePath)) ?? 0;

  const platformName = vodRecord.platform;
  const vodStreamTitle = vodRecord.title?.replace(/>|</gi, '') || '';

  const needsSplitting = duration > splitDuration;

  if (needsSplitting) {
    return await processSplitVodUpload({
      ...ctx,
      duration,
      splitDuration,
      channelName,
      domainName,
      privacyStatus,
      platformName,
      vodStreamTitle,
    });
  } else {
    return await processSingleVodUpload({
      ...ctx,
      channelName,
      domainName,
      privacyStatus,
      platformName,
      vodStreamTitle,
    });
  }
}

interface SplitVodUploadContext extends VodUploadContext {
  duration: number;
  splitDuration: number;
  channelName: string;
  domainName: string;
  privacyStatus: string;
  platformName: string;
  vodStreamTitle: string;
}

async function processSplitVodUpload(ctx: SplitVodUploadContext): Promise<VodUploadResult> {
  const { tenantId, vodId, filePath, duration, splitDuration, channelName, domainName, privacyStatus, platformName, vodStreamTitle, config, log } = ctx;
  const type = ctx.type;
  const totalParts = Math.ceil(duration / splitDuration);

  log.info({ duration, parts: totalParts }, 'VOD exceeds YouTube split duration, auto-splitting');

  const splitAlertMessageId = await initRichAlert({
    title: '📺 VOD Splitting in Progress',
    description: `${tenantId} - Preparing ${totalParts} parts...`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
      { name: 'Parts Count', value: String(totalParts), inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const parts = await splitVideo(filePath, duration, splitDuration, vodId, (percent: number) => {
    void updateAlert(splitAlertMessageId, {
      title: '📺 Splitting VOD',
      description: `${tenantId} - Preparing video parts for upload`,
      status: 'warning',
      fields: [{ name: 'Progress', value: formatProgressMessage('VOD Splitting', tenantId, percent), inline: false }],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    });
  });

  const uploadedVideos: Array<{ id: string; part: number }> = [];

  for (let i = 0; i < parts.length; i++) {
    const currentPartNum = i + 1;

    const { title: partTitle, description: youtubeDescription } = buildYoutubeMetadata({
      channelName,
      platform: platformName,
      vodDate: ctx.vodRecord.created_at,
      vodTitle: vodStreamTitle,
      domainName,
      timezone: config.settings?.timezone || 'UTC',
      youtubeDescription: config.youtube!.description,
      part: i > 0 ? i + 1 : undefined,
      type,
    });

    const uploadAlertMessageId = await initRichAlert({
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

    const onUploadProgress = uploadAlertMessageId
      ? createVodUploadProgressHandler({
          messageId: uploadAlertMessageId,
          type: UPLOAD_TYPES.VOD,
          channelName,
          videoTitle: partTitle,
          part: currentPartNum,
          totalParts,
        })
      : () => {};

    const result = await uploadVideo(tenantId, channelName, parts[i], partTitle, youtubeDescription, privacyStatus as 'public' | 'unlisted' | 'private', onUploadProgress);

    uploadedVideos.push({ id: result.videoId, part: i + 1 });

    if (!config.settings.saveMP4) {
      await deleteFile(parts[i]);
    }
  }

  void updateAlert(splitAlertMessageId, {
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

  return { uploadedVideos, needsPartLinking: uploadedVideos.length > 1 };
}

interface SingleVodUploadContext extends VodUploadContext {
  channelName: string;
  domainName: string;
  privacyStatus: string;
  platformName: string;
  vodStreamTitle: string;
}

async function processSingleVodUpload(ctx: SingleVodUploadContext): Promise<VodUploadResult> {
  const { tenantId, vodId, filePath, channelName, domainName, privacyStatus, platformName, vodStreamTitle, config, type, dbId, db, dmcaProcessed } = ctx;

  const { title: vodTitle, description: youtubeDescription } = buildYoutubeMetadata({
    channelName,
    platform: platformName,
    vodDate: ctx.vodRecord.created_at,
    vodTitle: vodStreamTitle,
    domainName,
    timezone: config.settings?.timezone || 'UTC',
    youtubeDescription: config.youtube!.description,
    type,
  });

  const uploadAlertMessageId = await initRichAlert({
    title: '📺 YouTube Upload Started',
    description: `${tenantId} - Uploading VOD to YouTube...`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Platform', value: platformName.toUpperCase(), inline: true },
    ],
    timestamp: new Date().toISOString(),
  });

  const onUploadProgress = uploadAlertMessageId
    ? createVodUploadProgressHandler({
        messageId: uploadAlertMessageId,
        type: UPLOAD_TYPES.VOD,
        channelName,
        videoTitle: vodTitle,
      })
    : () => {};

  const result = await uploadVideo(tenantId, channelName, filePath, vodTitle, youtubeDescription, privacyStatus as 'public' | 'unlisted' | 'private', onUploadProgress);

  const uploadedVideos = [{ id: result.videoId, part: 1 }];

  // Save to database
  await db.vodUpload.create({
    data: {
      vod_id: dbId,
      upload_id: result.videoId,
      type: UPLOAD_TYPES.VOD,
      part: 1,
      status: 'COMPLETED',
    },
  });

  if (!config.settings.saveMP4 || dmcaProcessed === true) {
    await deleteFile(filePath);
  }

  return { uploadedVideos, needsPartLinking: false };
}

export async function linkVodPartsAfterDelay(tenantId: string, uploadedVideos: Array<{ id: string; part: number }>): Promise<void> {
  if (uploadedVideos.length > 1) {
    setTimeout(() => {
      void linkParts(tenantId, uploadedVideos);
    }, 60000);
  }
}
