import { getYoutubeUploadQueue } from './queues.js';
import type { YoutubeUploadJob } from './queues.js';

export async function enqueueYoutubeUpload(job: Omit<YoutubeUploadJob, 'id'>): Promise<string | null> {
  const queue = getYoutubeUploadQueue();

  try {
    // Manual type casting due to BullMQ incomplete generic types
    const jobId = await (queue as any).add(job, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 900000, // 15 min for YouTube upload
    });

    console.log(`[YouTube Job] Enqueued ${job.type} upload: ${job.vodId}${job.part ? ` (part ${job.part})` : ''}`);
    return jobId;
  } catch (error) {
    console.error('[YouTube Job] Failed to enqueue job:', error);
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
    part,
  };

  if (chapterName && gameId) {
    jobData.chapter = { name: chapterName, start: 0, end: 0, gameId };
  } else if (part) {
    // For parts without chapters, no chapter field needed
  }

  const jobId = await enqueueYoutubeUpload(jobData);
  return jobId;
}

export async function triggerYoutubeUploadWithChapters(
  streamerId: string,
  vodId: string,
  filePath: string,
  title: string,
  description: string,
  type: 'vod' | 'game',
  part?: number,
  chapters?: { name: string; start: number; end: number; gameId?: string }[]
): Promise<string[]> {
  if (!chapters || chapters.length === 0) {
    const jobId = await triggerYoutubeUpload(streamerId, vodId, filePath, title, description, type, part);
    return jobId ? [jobId] : [];
  }

  // Upload parts sequentially with chapter information
  const jobIds: string[] = [];

  for (const chapter of chapters) {
    const jobId = await triggerYoutubeUpload(streamerId, vodId, filePath, title, description, type, part && chapters.length > 1 ? part : undefined, chapter.name, chapter.gameId);

    if (jobId) {
      jobIds.push(jobId);
    }
  }

  return jobIds;
}
