import { Jobs } from '../../constants.js';
import type { Platform } from '../../types/platforms.js';
import { isKickPlatform, isTwitchPlatform } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { getKickChatDownloadQueue, getTwitchChatDownloadQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { ChatDownloadJob } from './types.js';

const log = childLogger({ module: 'chat-job' });

async function enqueue(job: ChatDownloadJob): Promise<string | null> {
  const jobId = `${Jobs.CHAT_JOB_PREFIX}${job.vodId}`;
  try {
    const queue = isKickPlatform(job.platform)
      ? getKickChatDownloadQueue()
      : isTwitchPlatform(job.platform)
        ? getTwitchChatDownloadQueue()
        : null;

    if (!queue) {
      log.info({ platform: job.platform }, 'Chat download queue not found for platform');
      return null;
    }

    const result = await enqueueJobWithLogging({
      queue,
      jobName: 'chat_download',
      data: job,
      options: {
        jobId,
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
