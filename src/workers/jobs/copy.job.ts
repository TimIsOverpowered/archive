import { Jobs } from '../../constants.js';
import type { Platform } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { defaultJobOptions, getFileCopyQueue, getFlowProducer, getStandardVodQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { CopyFileJob } from './types.js';

const log = childLogger({ module: 'copy-job' });

export interface QueueFileCopyOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  sourcePath: string;
  destPath: string;
  downloadJobId?: string | undefined;
}

export async function queueFileCopy(options: QueueFileCopyOptions): Promise<string> {
  const { tenantId, dbId, vodId, platform, sourcePath, destPath, downloadJobId } = options;

  const jobId = `${Jobs.COPY_JOB_PREFIX}${vodId}`;

  const job: CopyFileJob = {
    tenantId,
    dbId,
    vodId,
    platform,
    sourcePath,
    destPath,
  };

  try {
    if (downloadJobId != null) {
      await getFlowProducer().add({
        name: 'file_copy',
        queueName: getFileCopyQueue().name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          ...defaultJobOptions,
          removeOnComplete: true,
          removeOnFail: true,
        },
        children: [
          {
            name: 'standard_vod_download',
            queueName: getStandardVodQueue().name,
            opts: { jobId: downloadJobId },
          },
        ],
      });
      log.info({ jobId, tenantId, vodId }, 'File copy job enqueued (chained to download)');
      return jobId;
    }

    const result = await enqueueJobWithLogging({
      queue: getFileCopyQueue(),
      jobName: 'file_copy',
      data: job,
      options: {
        jobId,
        deduplication: { id: jobId },
        ...defaultJobOptions,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'File copy job enqueued',
      extraContext: { tenantId, vodId },
    });

    if (!result.isNew) {
      log.info({ jobId, tenantId, vodId }, 'File copy job already exists');
    }
    return jobId;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    log.error({ jobId, tenantId, vodId, error: msg }, 'Failed to enqueue file copy job');
    throw error;
  }
}
