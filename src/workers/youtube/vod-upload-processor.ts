import type { Kysely } from 'kysely';
import type { StreamerDB } from '../../db/streamer-types';
import type { AppLogger } from '../../utils/logger.js';
import { splitVideo, getDuration } from '../utils/ffmpeg.js';
import { uploadVideo, saveChaptersAndLinkParts } from '../../services/youtube/index.js';
import { initRichAlert, updateAlert, createProgressBar } from '../../utils/discord-alerts.js';
import { toHHMMSS } from '../../utils/formatting.js';
import { getEffectiveSplitDuration } from './validation.js';
import { buildYoutubeMetadata } from './metadata-builder.js';
import { createYoutubeUploadProgressHandler as createVodUploadProgressHandler } from './youtube-upload-progress.js';
import type { TenantConfig } from '../../config/types.js';
import type { SourceType, Platform } from '../../types/platforms.js';
import { UPLOAD_TYPES } from '../../types/platforms.js';
import type { VodRecord } from '../../types/db.js';
import { deleteFileIfExists } from '../../utils/path.js';
import { extractErrorDetails } from '../../utils/error.js';

export interface VodUploadContext {
  tenantId: string;
  dbId: number;
  vodId: string;
  filePath?: string | undefined;
  db: Kysely<StreamerDB>;
  config: TenantConfig;
  dmcaProcessed?: boolean | undefined;
  log: AppLogger;
  type: SourceType;
  part?: number | undefined;
}

export interface VodUploadResult {
  uploadedVideos: Array<{ id: string; part: number; duration: number }>;
  needsPartLinking: boolean;
}

export async function processVodUpload(ctx: VodUploadContext): Promise<VodUploadResult> {
  const { tenantId, filePath, config, db, dbId } = ctx;

  if (!filePath) {
    throw new Error('File path is required for VOD upload');
  }

  const vodRecord = await db.selectFrom('vods').where('id', '=', dbId).selectAll().executeTakeFirst();

  if (!vodRecord) {
    throw new Error(`VOD record not found for dbId ${dbId}`);
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
      vodRecord,
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
  vodRecord: VodRecord;
}

async function processSplitVodUpload(ctx: SplitVodUploadContext): Promise<VodUploadResult> {
  const {
    tenantId,
    vodId,
    filePath,
    duration,
    splitDuration,
    channelName,
    domainName,
    privacyStatus,
    platformName,
    config,
    log,
    vodRecord,
    type,
  } = ctx;

  if (!filePath) {
    throw new Error('File path is required for VOD upload');
  }

  const totalParts = Math.ceil(duration / splitDuration);

  log.info({ duration, parts: totalParts }, 'VOD exceeds YouTube split duration, auto-splitting');

  const splitAlertMessageId = await initRichAlert({
    title: '📺 VOD Splitting Started',
    description: `${channelName} - Splitting long VOD into ${totalParts} parts`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
      { name: 'Parts', value: `${totalParts} parts (${toHHMMSS(splitDuration)} each)`, inline: false },
    ],
    timestamp: new Date().toISOString(),
  });

  const parts = await splitVideo(filePath, duration, splitDuration, vodId, (percent: number, partNum: number) => {
    updateAlert(splitAlertMessageId, {
      title: '📺 Splitting VOD',
      description: `${channelName} - Processing part ${partNum}/${totalParts}`,
      status: 'warning',
      fields: [
        { name: 'VOD ID', value: vodId, inline: true },
        { name: 'Part Progress', value: `${partNum}/${totalParts}`, inline: true },
        { name: 'Overall Progress', value: createProgressBar(percent), inline: false },
      ],
      timestamp: new Date().toISOString(),
      updatedTimestamp: new Date().toISOString(),
    }).catch((err) => {
      log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
    });
  });

  const uploadedVideos: Array<{ id: string; part: number; duration: number }> = [];

  for (let i = 0; i < parts.length; i++) {
    const currentPartNum = i + 1;
    const partPath = parts[i];
    if (!partPath) continue;

    const partDuration = i === parts.length - 1 ? duration - i * splitDuration : splitDuration;

    const { title: partTitle, description: youtubeDescription } = buildYoutubeMetadata({
      channelName,
      platform: platformName,
      vodRecord: vodRecord,
      domainName,
      timezone: config.settings?.timezone || 'UTC',
      youtubeDescription: config.youtube!.description,
      part: totalParts > 1 ? currentPartNum : undefined,
      type,
    });

    const uploadAlertMessageId = await initRichAlert({
      title: `📺 YouTube Upload (Part ${currentPartNum}/${totalParts})`,
      description: `${channelName} - Uploading video part to YouTube...`,
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
          privacyStatus: privacyStatus as 'public' | 'unlisted' | 'private',
        })
      : () => {};

    const result = await uploadVideo(
      tenantId,
      channelName,
      partPath,
      partTitle,
      youtubeDescription,
      privacyStatus as 'public' | 'unlisted' | 'private',
      onUploadProgress,
      partDuration
    );

    uploadedVideos.push({ id: result.videoId, part: i + 1, duration: partDuration });

    await deleteFileIfExists(partPath);
  }

  updateAlert(splitAlertMessageId, {
    title: `✅ VOD Splitting Complete`,
    description: `${channelName} - Successfully split into ${totalParts} parts`,
    status: 'success',
    fields: [
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Total Duration', value: toHHMMSS(duration), inline: true },
      { name: 'Parts Created', value: `${totalParts} parts`, inline: false },
    ],
    timestamp: new Date().toISOString(),
    updatedTimestamp: new Date().toISOString(),
  }).catch((err) => {
    log.warn({ err: extractErrorDetails(err), vodId }, 'Discord alert update failed (non-critical)');
  });

  return { uploadedVideos, needsPartLinking: uploadedVideos.length > 1 };
}

interface SingleVodUploadContext extends VodUploadContext {
  channelName: string;
  domainName: string;
  privacyStatus: string;
  platformName: Platform;
  vodRecord: VodRecord;
}

async function processSingleVodUpload(ctx: SingleVodUploadContext): Promise<VodUploadResult> {
  const {
    tenantId,
    vodId,
    filePath,
    channelName,
    domainName,
    privacyStatus,
    platformName,
    config,
    type,
    dmcaProcessed,
    vodRecord,
    part,
  } = ctx;

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
    description: `${channelName} - Uploading VOD to YouTube...`,
    status: 'warning',
    fields: [
      { name: 'VOD ID', value: vodId, inline: true },
      { name: 'Platform', value: platformName.toUpperCase(), inline: true },
    ],
    timestamp: new Date().toISOString(),
  });

  const duration = (await getDuration(filePath)) ?? vodRecord.duration;

  const onUploadProgress = uploadAlertMessageId
    ? createVodUploadProgressHandler({
        messageId: uploadAlertMessageId,
        type: UPLOAD_TYPES.VOD,
        channelName,
        videoTitle: title,
        privacyStatus: privacyStatus as 'public' | 'unlisted' | 'private',
      })
    : () => {};

  const result = await uploadVideo(
    tenantId,
    channelName,
    filePath,
    title,
    youtubeDescription,
    privacyStatus as 'public' | 'unlisted' | 'private',
    onUploadProgress,
    duration
  );

  const uploadPart = part ?? 1;
  const uploadedVideos = [{ id: result.videoId, part: uploadPart, duration }];

  if (!config.settings.saveMP4 || dmcaProcessed === true) {
    await deleteFileIfExists(filePath);
  }

  return { uploadedVideos, needsPartLinking: false };
}

export async function linkVodPartsAfterDelay(
  tenantId: string,
  dbId: number,
  uploadedVideos: Array<{ id: string; part: number; duration: number }>,
  splitDuration: number,
  db: Kysely<StreamerDB>,
  log: AppLogger
): Promise<void> {
  if (uploadedVideos.length > 0) {
    setTimeout(() => {
      (async () => {
        try {
          await saveChaptersAndLinkParts(tenantId, dbId, uploadedVideos, splitDuration, db);
        } catch (error) {
          log.error(
            { dbId, vodId: uploadedVideos[0]?.id, error: extractErrorDetails(error).message },
            'Failed to link VOD parts (non-fatal)'
          );
        }
      })();
    }, 60000);
  }
}
