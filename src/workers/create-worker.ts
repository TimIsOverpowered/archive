import { Processor, Worker, BaseJobOptions } from 'bullmq';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { WorkerName } from './worker-definitions.js';
import type { Redis } from 'ioredis';

export interface WorkerConfig<TData> {
  name: WorkerName;
  processor: Processor<TData, unknown, string>;
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

export function createWorker<TData>(config: WorkerConfig<TData>): Worker<TData, unknown> {
  const { name, processor, connection, concurrency = 1, useWorkerThreads = false } = config;

  const worker = new Worker<TData, unknown>(name, processor, {
    connection,
    concurrency,
    useWorkerThreads,
  });

  worker.on('active', (job) => {
    if (job == null) return;
    getLogger().debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>), attemptsMade: job.attemptsMade },
      `[${name}] job started`
    );
  });

  worker.on('completed', (job) => {
    if (job == null) return;
    getLogger().debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>) },
      `[${name}] job completed`
    );
  });

  worker.on('failed', (job, err) => {
    if (job == null || err == null) return;
    getLogger().error(
      {
        jobId: String(job.id),
        ...extractJobMeta(job.data as Record<string, unknown>),
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
function extractJobMeta(data: Record<string, unknown>) {
  return {
    vodId: data.vodId,
    platform: data.platform,
    tenantId: data.tenantId,
    type: data.type,
    reqId: data.reqId,
  };
}
