import { defaultJobOptions, flowProducer, getDmcaProcessingQueue, getStandardVodQueue } from './queues.js';
import type { DmcaProcessingJob } from './queues.js';
import { childLogger } from '../../utils/logger.js';
import type { Platform, SourceType } from '../../types/platforms.js';

const log = childLogger({ module: 'dmca-job' });

export interface QueueDmcaProcessingOptions {
  tenantId: string;
  dbId: number;
  vodId: string;
  claims: unknown[];
  type: SourceType;
  platform: Platform;
  part?: number;
  downloadJobId?: string;
  filePath?: string;
}

export async function queueDmcaProcessing(options: QueueDmcaProcessingOptions): Promise<string | null> {
  const { tenantId, dbId, vodId, claims, type, platform, part, downloadJobId, filePath } = options;

  const jobId = part !== undefined ? `dmca_${vodId}_p${part}` : `dmca_${vodId}`;

  const job: DmcaProcessingJob = {
    tenantId,
    dbId,
    vodId,
    receivedClaims: claims as never[],
    type,
    platform,
    ...(part !== undefined && { part }),
    ...(filePath !== undefined && { filePath }),
  };

  try {
    if (downloadJobId) {
      const flow = await flowProducer.add({
        name: 'dmca_processing',
        queueName: getDmcaProcessingQueue().name,
        data: job,
        opts: {
          jobId,
          deduplication: { id: jobId },
          ...defaultJobOptions,
        },
        children: [
          {
            name: 'standard_vod_download',
            queueName: getStandardVodQueue().name,
            opts: { jobId: downloadJobId },
          },
        ],
      });

      const resultJobId = flow.job.id ?? null;
      log.info({ vodId, jobId: resultJobId, part, chained: true, claimsCount: claims.length }, 'DMCA processing job queued (chained to download)');
      return resultJobId;
    }

    const addedJob = await getDmcaProcessingQueue().add('dmca_processing', job, {
      jobId,
      deduplication: { id: jobId },
      ...defaultJobOptions,
    });

    const resultJobId = addedJob.id ?? null;
    log.info({ vodId, jobId: resultJobId, part, chained: false, claimsCount: claims.length }, 'DMCA processing job queued (file exists)');
    return resultJobId;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('deduplication')) {
      log.info({ jobId, tenantId, error: msg }, 'Failed to enqueue DMCA processing job');
    }
    return null;
  }
}
