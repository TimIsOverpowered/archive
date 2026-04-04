import { Queue, JobsOptions } from 'bullmq';
import type { JobLogger, JobEnqueueResult } from '../types/queues.js';

export async function enqueueJobWithLogging(
  queue: Queue<unknown, unknown, string>,
  name: string,
  data: unknown,
  options: JobsOptions,
  logger: JobLogger,
  successMessage: string,
  extraContext?: Record<string, unknown>
): Promise<JobEnqueueResult> {
  const job = await queue.add(name, data, options);
  const state = await job.getState();
  const context = { jobId: String(job.id), state, ...extraContext };

  if (state === 'active' || state === 'completed' || state === 'failed') {
    logger.info(context, `Job already exists in state ${state}, skipping`);
    return { jobId: String(job.id), isNew: false };
  } else {
    logger.info(context, successMessage);
    return { jobId: String(job.id), isNew: true };
  }
}
