import type { YoutubeUploadJob } from './queues.js';
import { getYoutubeUploadQueue } from './queues.js';

export async function enqueueYoutubeUpload(job: Omit<YoutubeUploadJob, 'id'>, jobId: string): Promise<string | null> {
  const queue = getYoutubeUploadQueue();

  try {
    const addedJob = await queue.add('youtube_upload', job, {
      jobId,
      deduplication: { id: jobId },
    });
    return addedJob.id ?? null;
  } catch {
    return null;
  }
}

export async function triggerYoutubeUpload(
  tenantId: string,
  vodId: string,
  filePath: string,
  title: string,
  description: string,
  type: 'vod' | 'game',
  platform?: 'twitch' | 'kick',
  part?: number,
  chapterName?: string,
  gameId?: string
): Promise<string | null> {
  const jobData: Omit<YoutubeUploadJob, 'id'> = {
    tenantId,
    vodId,
    filePath,
    title,
    description,
    type,
    platform,
    part,
  };

  if (chapterName && gameId) {
    jobData.chapter = { name: chapterName, start: 0, end: 0, gameId };
  } else if (part) {
    // For parts without chapters, no chapter field needed
  }

  const jobId = `youtube_${vodId}`;
  return enqueueYoutubeUpload(jobData, jobId);
}
