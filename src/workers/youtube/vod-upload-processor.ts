import type { PrismaClient } from '../../../generated/streamer/client.js';
import type { AppLogger } from '../../utils/logger.js';
import { splitVideo, getDuration } from '../utils/ffmpeg.js';
import { uploadVideo, saveChaptersAndLinkParts } from '../../services/youtube/index.js';
import { initRichAlert, updateAlert, formatProgressMessage } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { getEffectiveSplitDuration } from './validation.js';
import { buildYoutubeMetadata } from './metadata-builder.js';
import { createYoutubeUploadProgressHandler as createVodUploadProgressHandler } from './youtube-upload-progress.js';
import type { TenantConfig } from '../../config/types.js';
import type { SourceType, Platform } from '../../types/platforms.js';
import { UPLOAD_TYPES } from '../../types/platforms.js';
import type { VodRecord } from '../../types/db.js';
import { deleteFileIfExists } from '../../utils/path.js';

export interface VodUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string;
  db: PrismaClient;
  config: TenantConfig;
  vodRecord: VodRecord;
  dmcaProcessed?: boolean;
  log: AppLogger;
  type: SourceType;
  part?: number;
}

export interface VodUploadResult {
  uploadedVideos: Array<{ id: string; part: number }>;
  needsPartLinking: boolean;
}

export async function processVodUpload(ctx: VodUploadContext): Promise<VodUploadResult> {
  const { tenantId, filePath, config, vodRecord } = ctx;

  if (!filePath) {
    throw new Error('File path is required for VOD upload');
  }

  const channelName = config.displayName || tenantId;
  const domainName = config.settings?.domainName || 'localhost';
  const privacyStatus = config.youtube!.public ? 'public' : 'unlisted';
  const splitDuration = getEffectiveSplitDuration(config.youtube!.splitDuration);
  const duration = (await getDuration(filePath)) ?? vodRecord.duration;

  const platformName = vodRecord.platform as Platform;

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
      vodRecord,
    });
  } else {
    return await processSingleVodUpload({
      ...ctx,
      channelName,
      domainName,
      privacyStatus,
      platformName,
    });
  }
}

interface SplitVodUploadContext extends VodUploadContext {
  duration: number;
  splitDuration: number;
  channelName: string;
  domainName: string;
  privacyStatus: string;
  platformName: Platform;
}

async function processSplitVodUpload(ctx: SplitVodUploadContext): Promise<VodUploadResult> {
  const { tenantId, vodId, filePath, duration, splitDuration, channelName, domainName, privacyStatus, platformName, config, log, vodRecord, type } = ctx;

  if (!filePath) {
    throw new Error('File path is required for VOD upload');
  }

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
      vodRecord: vodRecord,
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
      await deleteFileIfExists(parts[i]);
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
  platformName: Platform;
}

async function processSingleVodUpload(ctx: SingleVodUploadContext): Promise<VodUploadResult> {
  const { tenantId, vodId, filePath, channelName, domainName, privacyStatus, platformName, config, type, dbId, db, dmcaProcessed, vodRecord, part } = ctx;

  if (!filePath) {
    throw new Error('File path is required for VOD upload');
  }

  const title = vodRecord.title?.replace(/>|</gi, '') || '';
  const { description: youtubeDescription } = buildYoutubeMetadata({
    channelName,
    platform: platformName,
    vodRecord,
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
        videoTitle: title,
      })
    : () => {};

  const result = await uploadVideo(tenantId, channelName, filePath, title, youtubeDescription, privacyStatus as 'public' | 'unlisted' | 'private', onUploadProgress);

  const uploadPart = part ?? 1;
  const uploadedVideos = [{ id: result.videoId, part: uploadPart }];

  // Save to database
  await db.vodUpload.create({
    data: {
      vod_id: dbId,
      upload_id: result.videoId,
      type: UPLOAD_TYPES.VOD,
      part: uploadPart,
      status: 'COMPLETED',
    },
  });

  if (!config.settings.saveMP4 || dmcaProcessed === true) {
    await deleteFileIfExists(filePath);
  }

  return { uploadedVideos, needsPartLinking: false };
}

export async function linkVodPartsAfterDelay(tenantId: string, dbId: number, uploadedVideos: Array<{ id: string; part: number }>, splitDuration: number, db: PrismaClient): Promise<void> {
  if (uploadedVideos.length > 0) {
    setTimeout(async () => {
      await saveChaptersAndLinkParts(tenantId, dbId, uploadedVideos, splitDuration, db);
    }, 60000);
  }
}
