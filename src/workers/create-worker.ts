import { Worker, BaseJobOptions } from 'bullmq';
import { logger } from '../utils/logger.js';
import { WorkerConfig, WorkerName } from './worker-definitions.js';
import type { Redis } from 'ioredis';

export const workers = new Map<WorkerName, Worker<Record<string, unknown>, unknown>>();

export function registerWorker(name: WorkerName, worker: Worker<Record<string, unknown>, unknown>) {
  workers.set(name, worker);
}

export async function waitForWorkersReady(workerInstances: Worker[]): Promise<void> {
  const readyPromises = workerInstances.map((worker) => {
    if (worker.isRunning()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      worker.once('ready', () => resolve());
    });
  });

  await Promise.all(readyPromises);
}

export function createWorker<TData extends object, TResult>(
  config: WorkerConfig<TData, TResult> & { connection: Redis }
): Worker<TData, TResult> {
  const { name, queueName, processor, connection, concurrency = 1, useWorkerThreads = false } = config;

  const worker = new Worker<TData, TResult>(queueName, processor, {
    connection,
    concurrency,
    useWorkerThreads,
  });

  worker.on('active', (job) => {
    if (!job) return;
    logger.debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>), attemptsMade: job.attemptsMade },
      `[${name}] job started`
    );
  });

  worker.on('completed', (job) => {
    if (!job) return;
    logger.debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>) },
      `[${name}] job completed`
    );
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

  worker.on('stalled', async (jobId) => {
    logger.warn(
      { jobId, queueName: queueName.toString() },
      `[${name}] Job stalled - lock may have expired. This typically happens when a job takes longer than the lock duration (default: 30s). Check if event loop is blocked.`
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
    reqId: data?.reqId,
  };
}
