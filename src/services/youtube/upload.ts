import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { YouTube } from '../../constants.js';
import type { StreamerDB } from '../../db/streamer-types.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { extractErrorDetails } from '../../utils/error.js';
import { ProgressStream } from '../../utils/progress-stream.js';
import { createYoutubeClient } from './client.js';

export interface UploadedVideo {
  id: string;
  part: number;
  duration: number;
}

export async function saveUploadResult(
  db: Kysely<StreamerDB>,
  vodId: number,
  type: string,
  videos: UploadedVideo[]
): Promise<void> {
  for (const video of videos) {
    await db
      .insertInto('vod_uploads')
      .values({
        vod_id: vodId,
        upload_id: video.id,
        type,
        duration: video.duration,
        part: video.part,
        status: 'COMPLETED',
      })
      .onConflict((oc) =>
        oc
          .columns(['vod_id', 'type', 'part'])
          .doUpdateSet({ upload_id: video.id, status: 'COMPLETED', duration: video.duration })
      )
      .execute();
  }
}

export async function markUploadFailed(db: Kysely<StreamerDB>, vodId: number, type: string): Promise<void> {
  await db
    .updateTable('vod_uploads')
    .set({ status: 'FAILED' })
    .where('vod_id', '=', vodId)
    .where('type', '=', type)
    .execute();
}

/** Progress callback data for YouTube video upload events. */
export interface UploadProgressCallbackData {
  milestone: 'starting' | 'uploading' | 'processing_metadata' | 'success' | 'error';
  videoId?: string;
  thumbnailUrl?: string;
  errorDetails?: Error;
  percent?: number;
  bytesUploaded?: number;
  totalBytes?: number;
  uploadSpeedBps?: number;
  etaSeconds?: number;
  videoDuration?: number | undefined;
  privacyStatus?: string;
}

/** Callback type for receiving YouTube upload progress updates. */
export type YoutubeUploadProgress = (data: UploadProgressCallbackData) => void | Promise<void>;

/**
 * Upload a video file to YouTube with progress callbacks.
 * Returns the video ID and thumbnail URL on success.
 */
export async function uploadVideo(
  tenantId: string,
  displayName: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private',
  onProgress?: YoutubeUploadProgress,
  videoDuration?: number
): Promise<{ videoId: string; thumbnailUrl: string }> {
  const logger = createAutoLogger('youtube-upload');
  const uploadStartTime = Date.now();

  if (onProgress) {
    await onProgress({ milestone: 'starting' });
  }

  try {
    const youtube = await createYoutubeClient(tenantId);

    const fileSize = (await fsPromises.stat(filePath)).size;
    const fileName = filePath.split('/').pop() ?? filePath;

    logger.info(
      { component: 'youtube-upload', tenantId, title, fileSize, fileName, privacyStatus },
      `Starting upload for ${displayName}: ${title}`
    );

    const progressStream = new ProgressStream(fileSize, (progressData) => {
      if (onProgress) {
        void onProgress({
          milestone: 'uploading',
          percent: progressData.percent,
          bytesUploaded: progressData.bytesUploaded,
          totalBytes: fileSize,
          uploadSpeedBps: progressData.speed,
          etaSeconds: progressData.eta,
        });
      }
    });
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(progressStream);

    const response = await youtube.videos.insert({
      part: ['id', 'snippet', 'status'],
      requestBody: {
        snippet: { title, description, categoryId: YouTube.CATEGORY_ID },
        status: { privacyStatus },
      },
      media: { body: progressStream },
    });

    const videoId = response.data?.id;
    if (videoId == null) throw new Error('Upload completed but no video ID returned');

    logger.info(
      { component: 'youtube-upload', tenantId, videoId, uploadDuration: Date.now() - uploadStartTime },
      'Upload completed'
    );

    if (onProgress) {
      await onProgress({ milestone: 'processing_metadata', videoId });
    }

    let thumbnailUrl = '';
    const thumbs = response?.data?.snippet?.thumbnails;
    thumbnailUrl = thumbs?.high?.url ?? thumbs?.medium?.url ?? '';

    if (onProgress) {
      await onProgress({ milestone: 'success', videoId, thumbnailUrl, videoDuration, privacyStatus });
    }

    logger.info(
      { component: 'youtube-upload', tenantId, videoId, totalDuration: Date.now() - uploadStartTime },
      'Upload completed successfully'
    );

    return { videoId, thumbnailUrl };
  } catch (err) {
    const details = extractErrorDetails(err);
    const uploadDuration = Date.now() - uploadStartTime;

    logger.error(
      { component: 'youtube-upload', ...details, tenantId, uploadDuration, title },
      `Upload failed for ${displayName}`
    );

    if (onProgress) {
      await onProgress({ milestone: 'error', errorDetails: err as Error });
    }

    throw err;
  }
}
