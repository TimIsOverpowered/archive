import fs from 'fs';
import { createYoutubeClient } from './client.js';
import { extractErrorDetails } from '../../utils/error.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { ProgressStream } from '../../utils/progress-stream.js';

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
  videoDuration?: number;
  privacyStatus?: string;
}

export type YoutubeUploadProgress = (data: UploadProgressCallbackData) => void | Promise<void>;

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

    const fileSize = fs.statSync(filePath).size;
    const fileName = filePath.split('/').pop() || filePath;

    logger.info(
      { tenantId, title, fileSize, fileName, privacyStatus },
      `[YouTube] Starting upload for ${displayName}: ${title}`
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
        snippet: { title, description, categoryId: '20' },
        status: { privacyStatus },
      },
      media: { body: progressStream },
    });

    const videoId = response.data?.id;
    if (!videoId) throw new Error('Upload completed but no video ID returned');

    logger.info({ tenantId, videoId, uploadDuration: Date.now() - uploadStartTime }, '[YouTube] Upload completed');

    if (onProgress) {
      await onProgress({ milestone: 'processing_metadata', videoId });
    }

    let thumbnailUrl = '';
    const thumbs = response?.data?.snippet?.thumbnails;
    thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || '';

    if (onProgress) {
      await onProgress({ milestone: 'success', videoId, thumbnailUrl, videoDuration, privacyStatus });
    }

    logger.info(
      { tenantId, videoId, totalDuration: Date.now() - uploadStartTime },
      '[YouTube] Upload completed successfully'
    );

    return { videoId, thumbnailUrl };
  } catch (err) {
    const details = extractErrorDetails(err);
    const uploadDuration = Date.now() - uploadStartTime;

    logger.error({ ...details, tenantId, uploadDuration, title }, `[YouTube] Upload failed for ${displayName}`);

    if (onProgress) {
      await onProgress({ milestone: 'error', errorDetails: err as Error });
    }

    throw err;
  }
}
