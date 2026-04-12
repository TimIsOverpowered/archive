// workers/createWorker.ts
import { Worker, BaseJobOptions } from 'bullmq';
import { logger } from '../utils/logger.js';
import { registerWorker } from './index.js';
import { WorkerConfig } from './worker-definitions.js';
import type { Redis } from 'ioredis';

export function createWorker<TData extends object, TResult>(config: WorkerConfig<TData, TResult> & { connection: Redis }): Worker<TData, TResult> {
  const { name, queueName, processor, connection, concurrency = 3 } = config;

  const worker = new Worker<TData, TResult>(queueName, processor, {
    connection,
    concurrency,
    useWorkerThreads: true,
  });

  worker.on('active', (job) => {
    if (!job) return;
    logger.info({ jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>), attemptsMade: job.attemptsMade }, `[${name}] job started`);
  });

  worker.on('completed', (job) => {
    if (!job) return;
    logger.info({ jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>) }, `[${name}] job completed`);
  });

  worker.on('failed', (job, err) => {
    if (!job || !err) return;
    logger.error(
      {
        jobId: String(job.id),
        ...extractJobMeta(job.data as Record<string, unknown>),
        attemptsMade: job.attemptsMade,
        maxAttempts: (job.opts as Partial<BaseJobOptions>).attempts ?? 3,
        errorMessage: err.message,
        errorStack: err.stack ?? 'No stack trace',
      },
      `[${name}] job failed`
    );
  });

  registerWorker(name, worker as Worker);
  logger.info(`[Workers] ${name} worker created`);

  return worker;
}

function extractJobMeta(data: Record<string, unknown>) {
  return {
    vodId: data?.vodId,
    platform: data?.platform,
    tenantId: data?.tenantId,
    type: data?.type,
  };
}
