import type { YoutubeUploadJob } from './queues.js';
import { getYoutubeUploadQueue } from './queues.js';

export async function enqueueYoutubeUpload(job: YoutubeUploadJob, jobId: string): Promise<string | null> {
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
  dbId: number,
  vodId: string,
  filePath: string,
  title: string,
  description: string,
  type: 'vod' | 'game',
  platform?: 'twitch' | 'kick',
  part?: number
): Promise<string | null> {
  const jobData: YoutubeUploadJob = {
    tenantId,
    dbId,
    vodId,
    filePath,
    title,
    description,
    type,
    platform,
    part,
  };

  const jobId = `youtube_${jobData.vodId}_${jobData.type}${jobData.part != null ? `_part${jobData.part}` : ''}${jobData.chapter?.gameId ? `_${jobData.chapter.gameId}` : ''}`;
  return enqueueYoutubeUpload(jobData, jobId);
}
