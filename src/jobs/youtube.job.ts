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
  streamerId: string,
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
    streamerId,
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

export async function triggerYoutubeUploadWithChapters(
  streamerId: string,
  vodId: string,
  filePath: string,
  title: string,
  description: string,
  type: 'vod' | 'game',
  platform?: 'twitch' | 'kick',
  part?: number,
  chapters?: { name: string; start: number; end: number; gameId?: string }[]
): Promise<string[]> {
  if (!chapters || chapters.length === 0) {
    const jobId = await triggerYoutubeUpload(streamerId, vodId, filePath, title, description, type, platform, part);
    return jobId ? [jobId] : [];
  }

  // Upload parts sequentially with chapter information
  const jobIds: string[] = [];

  for (const chapter of chapters) {
    const jobId = await triggerYoutubeUpload(streamerId, vodId, filePath, title, description, type, platform, part && chapters.length > 1 ? part : undefined, chapter.name, chapter.gameId);

    if (jobId) {
      jobIds.push(jobId);
    }
  }

  return jobIds;
}
