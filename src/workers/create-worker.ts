import { Processor, Worker, BaseJobOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import { WorkerName } from './queues/queue.js';

export interface WorkerConfig<TData, TResult = unknown> {
  name: WorkerName;
  processor: Processor<TData, TResult, string>;
  concurrency?: number;
  useWorkerThreads?: boolean;
  connection: Redis;
}

export class WorkerRegistry {
  private entries = new Map<WorkerName, { name: WorkerName; worker: Worker<unknown, unknown> }>();

  register(name: WorkerName, worker: Worker<unknown, unknown>): void {
    this.entries.set(name, { name, worker });
  }

  get(name: WorkerName): Worker<unknown, unknown> | undefined {
    return this.entries.get(name)?.worker;
  }

  getAll(): { name: WorkerName; worker: Worker<unknown, unknown> }[] {
    return Array.from(this.entries.values());
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const workerRegistry = new WorkerRegistry();

export async function waitForWorkersReady(workerInstances: Worker[], timeoutMs = 30_000): Promise<void> {
  const readyPromises = workerInstances.map((worker) => {
    if (worker.isRunning()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Worker ${worker.name} did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);

      worker.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  await Promise.all(readyPromises);
}

export function createWorker<TData, TResult = unknown>(config: WorkerConfig<TData, TResult>): Worker<TData, TResult> {
  const { name, processor, connection, concurrency = 1, useWorkerThreads = false } = config;

  const worker = new Worker<TData, TResult>(name, processor, {
    connection,
    concurrency,
    useWorkerThreads,
  });

  worker.on('active', (job) => {
    if (job == null) return;
    getLogger().debug(
      { jobId: String(job.id), ...extractJobMeta(job.data), attemptsMade: job.attemptsMade },
      `[${name}] job started`
    );
  });

  worker.on('completed', (job) => {
    if (job == null) return;
    getLogger().info({ jobId: String(job.id), ...extractJobMeta(job.data) }, `[${name}] job completed`);
  });

  worker.on('failed', (job, err) => {
    if (job == null || err == null) return;
    getLogger().error(
      {
        jobId: String(job.id),
        ...extractJobMeta(job.data),
        attemptsMade: job.attemptsMade,
        maxAttempts: (job.opts as Partial<BaseJobOptions>).attempts ?? 3,
        errorMessage: err.message,
        errorStack: err.stack ?? 'No stack trace',
      },
      `job failed`
    );
  });

  worker.on('stalled', (jobId) => {
    getLogger().warn(
      { component: 'worker', jobId, queueName: name },
      'Job stalled - lock may have expired. This typically happens when a job takes longer than the lock duration (default: 30s). Check if event loop is blocked.'
    );
  });

  worker.on('error', (err) => {
    const details = extractErrorDetails(err);
    getLogger().error({ component: 'worker', workerName: name, err: details }, 'worker error');
  });

  workerRegistry.register(name, worker as Worker<unknown, unknown>);
  getLogger().info({ name }, 'Worker created');

  return worker;
}

/**
 * Extracts job metadata from raw job data.
 * All returned values will be `unknown | undefined` when the key is absent.
 */
function extractJobMeta(data: unknown) {
  if (typeof data !== 'object' || data == null) {
    return { vodId: undefined, platform: undefined, tenantId: undefined, type: undefined, reqId: undefined };
  }
  const obj = data as Record<string, unknown>;
  return {
    vodId: obj.vodId,
    platform: obj.platform,
    tenantId: obj.tenantId,
    type: obj.type,
    reqId: obj.reqId,
  };
}
