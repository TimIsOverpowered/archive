import type { Queue, BaseJobOptions } from 'bullmq';
import { extractErrorDetails } from '../utils/error.js';
import { getQueue } from './jobs/queues.js';
import { workers } from './create-worker.js';
import { AllJobData } from './worker-definitions.js';
import { logger } from '../utils/logger.js';

export interface LastFailedJob {
  jobId: string;
  errorMessage: string;
  attemptsMade: number;
  maxAttempts: number;
  vodId?: number;
  failedAt?: Date;
}

export interface WorkerHealthStatus {
  isRunning: boolean | null;
  queueCounts: Record<string, number>;
  lastFailedJob: LastFailedJob | null;
  status: 'healthy' | 'warning' | 'error';
}

async function getLastFailedJob(queue: Queue): Promise<LastFailedJob | null> {
  try {
    const failedJobs = await queue.getFailed(0, 1);

    if (!failedJobs || failedJobs.length === 0) {
      return null;
    }

    const job = failedJobs[0];

    if (!job) {
      return null;
    }

    const rawData = (await job.data) as AllJobData;
    const finishedAtTimestamp = typeof job.finishedOn === 'number' ? new Date(job.finishedOn) : undefined;

    return {
      jobId: String(job.id),
      errorMessage: (job.failedReason || 'Unknown error').substring(0, 500),
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: ((job.opts as Partial<BaseJobOptions>).attempts ?? 3) as number,
      vodId: 'vodId' in rawData ? Number(rawData.vodId) : undefined,
      failedAt: finishedAtTimestamp ?? new Date(),
    };
  } catch {
    return null;
  }
}

export async function getWorkersHealth(): Promise<Record<string, WorkerHealthStatus>> {
  const result: Record<string, WorkerHealthStatus> = {};

  for (const name of workers.keys()) {
    const queue = getQueue(name);
    try {
      const counts = await queue.getJobCounts();
      const lastFailed = await getLastFailedJob(queue);

      const workerInstance = workers.get(name);
      if (!workerInstance) continue;
      const isRunningVal = workerInstance.isRunning();

      let status: 'healthy' | 'warning' | 'error' = 'healthy';

      if (
        lastFailed?.attemptsMade !== undefined &&
        lastFailed.maxAttempts > 0 &&
        lastFailed.attemptsMade >= lastFailed.maxAttempts
      ) {
        status = 'error';
      } else if ((counts.failed ?? 0) > 0 || (counts.paused ?? 0) > 0) {
        status = 'warning';
      }

      result[name] = {
        isRunning: isRunningVal,
        queueCounts: counts,
        lastFailedJob: lastFailed,
        status,
      };
    } catch (error) {
      const details = extractErrorDetails(error);
      const errorMessage = details.message;
      logger.error({ workerName: name, error: errorMessage }, `Health check failed for ${name} queue`);

      result[name] = {
        isRunning: null,
        queueCounts: {},
        lastFailedJob: null,
        status: 'error',
      };
    }
  }

  return result;
}
