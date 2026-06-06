import { Jobs } from '../../constants.js';
import type { Platform } from '../../types/platforms.js';
import { extractErrorDetails } from '../../utils/error.js';
import { childLogger } from '../../utils/logger.js';
import { defaultJobOptions, getFlowProducer, getHlsConvertQueue, getStandardVodQueue } from '../queues/queue.js';
import { enqueueJobWithLogging } from './enqueue.js';
import type { HlsConvertJob } from './types.js';

const log = childLogger({ module: 'hls-convert-job' });

export interface QueueHlsConvertOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  platform: Platform;
  hlsDirPath: string;
  outputMp4Path: string;
  downloadJobId?: string | undefined;
}

export async function queueHlsConvert(options: QueueHlsConvertOptions): Promise<string> {
  const { tenantId, dbId, vodId, platform, hlsDirPath, outputMp4Path, downloadJobId } = options;

  const jobId = `${Jobs.HLS_CONVERT_JOB_PREFIX}${vodId}`;

  const job: HlsConvertJob = {
    tenantId,
    dbId,
    vodId,
    platform,
    hlsDirPath,
    outputMp4Path,
  };

  try {
    if (downloadJobId != null) {
      await getFlowProducer().add({
        name: 'hls_convert',
        queueName: getHlsConvertQueue().name,
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
            opts: { jobId: downloadJobId, failParentOnFailure: false },
          },
        ],
      });
      log.info({ jobId, tenantId, vodId }, 'HLS convert job enqueued (chained to download)');
      return jobId;
    }

    const result = await enqueueJobWithLogging({
      queue: getHlsConvertQueue(),
      jobName: 'hls_convert',
      data: job,
      options: {
        jobId,
        deduplication: { id: jobId },
        ...defaultJobOptions,
        removeOnComplete: true,
        removeOnFail: true,
      },
      logger: { info: log.info.bind(log), debug: log.debug.bind(log) },
      successMessage: 'HLS convert job enqueued',
      extraContext: { tenantId, vodId },
    });

    if (!result.isNew) {
      log.info({ jobId, tenantId, vodId }, 'HLS convert job already exists');
    }
    return jobId;
  } catch (error) {
    const msg = extractErrorDetails(error).message;
    log.error({ jobId, tenantId, vodId, error: msg }, 'Failed to enqueue HLS convert job');
    throw error;
  }
}
