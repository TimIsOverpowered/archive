import fs from 'fs';
import { createYoutubeClient } from './api.js';
import { getValidYoutubeToken } from './auth.js';
import { sleep } from '../../utils/delay.js';
import { extractErrorDetails } from '../../utils/error.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';

export interface UploadProgressCallbackData {
  milestone: 'starting' | 'processing_metadata' | 'success' | 'error';
  videoId?: string;
  thumbnailUrl?: string;
  errorDetails?: Error;
}

export type YoutubeUploadProgress = (data: UploadProgressCallbackData) => void | Promise<void>;

export async function uploadVideo(
  tenantId: string,
  displayName: string,
  filePath: string,
  title: string,
  description: string,
  privacyStatus: 'public' | 'unlisted' | 'private',
  onProgress?: YoutubeUploadProgress
): Promise<{ videoId: string; thumbnailUrl: string }> {
  const logger = createAutoLogger('youtube-upload');

  if (onProgress) {
    await onProgress({ milestone: 'starting' });
  }

  try {
    const accessToken = await getValidYoutubeToken(tenantId);
    const youtube = createYoutubeClient(accessToken);

    logger.info(`[YouTube] Starting upload for ${displayName}: ${title}`);

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description },
        status: { privacyStatus },
      },
      media: { body: fs.createReadStream(filePath) },
    });

    const videoId = response.data?.id;
    if (!videoId) throw new Error('Upload completed but no video ID returned');

    if (onProgress) {
      await onProgress({ milestone: 'processing_metadata', videoId });
    }

    await sleep(3000);

    let thumbnailUrl = '';
    const meta = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
    const thumbs = meta.data?.items?.[0]?.snippet?.thumbnails;
    thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || '';

    if (onProgress) {
      await onProgress({ milestone: 'success', videoId, thumbnailUrl });
    }

    return { videoId, thumbnailUrl };
  } catch (err) {
    const details = extractErrorDetails(err);
    logger.error(details, `[YouTube] Upload failed for ${displayName}`);

    if (onProgress) {
      await onProgress({ milestone: 'error', errorDetails: err as Error });
    }

    throw err;
  }
}
