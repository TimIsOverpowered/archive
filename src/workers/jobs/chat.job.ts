import { Platform, PLATFORMS } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { getChatDownloadQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { ChatDownloadJob } from './types.js';

const log = childLogger({ module: 'chat-job' });

async function enqueue(job: ChatDownloadJob): Promise<string | null> {
  const jobId = `chat_${job.vodId}`;
  try {
    const result = await enqueueJobWithLogging({
      queue: getChatDownloadQueue(),
      jobName: 'chat_download',
      data: job,
      options: {
        jobId,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'Chat download job enqueued',
      extraContext: { tenantId: job.tenantId, vodId: job.vodId, platform: job.platform },
    });
    return result.isNew ? result.jobId : null;
  } catch (error) {
    log.error(
      { jobId, tenantId: job.tenantId, error: extractErrorDetails(error).message },
      'Failed to enqueue chat job'
    );
    return null;
  }
}

export interface TriggerChatOptions {
  tenantId: string;
  displayName?: string | undefined;
  platformUserId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  duration: number;
  platformUsername?: string | undefined;
  forceRerun?: boolean | undefined;
}

export async function triggerChatDownload(opts: TriggerChatOptions): Promise<string | null> {
  if (opts.platform === PLATFORMS.KICK) return null;
  return enqueue({
    tenantId: opts.tenantId,
    displayName: opts.displayName,
    platformUserId: opts.platformUserId,
    platformUsername: opts.platformUsername,
    dbId: opts.dbId,
    vodId: opts.vodId,
    platform: opts.platform,
    duration: opts.duration,
    forceRerun: opts.forceRerun,
  });
}
