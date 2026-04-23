import { Processor, Worker, BaseJobOptions } from 'bullmq';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { WorkerName } from './worker-definitions.js';
import type { Redis } from 'ioredis';

export interface WorkerConfig {
  name: WorkerName;
  processor: Processor<Record<string, unknown>, unknown, string>;
  concurrency?: number;
  useWorkerThreads?: boolean;
  connection: Redis;
}

export class WorkerRegistry {
  private entries = new Map<WorkerName, { name: WorkerName; worker: Worker<Record<string, unknown>, unknown> }>();

  register(name: WorkerName, worker: Worker<Record<string, unknown>, unknown>): void {
    this.entries.set(name, { name, worker });
  }

  get(name: WorkerName): Worker<Record<string, unknown>, unknown> | undefined {
    return this.entries.get(name)?.worker;
  }

  getAll(): { name: WorkerName; worker: Worker<Record<string, unknown>, unknown> }[] {
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

export function createWorker(config: WorkerConfig): Worker<Record<string, unknown>, unknown> {
  const { name, processor, connection, concurrency = 1, useWorkerThreads = false } = config;

  const worker = new Worker<Record<string, unknown>, unknown>(name, processor, {
    connection,
    concurrency,
    useWorkerThreads,
  });

  worker.on('active', (job) => {
    if (!job) return;
    getLogger().debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>), attemptsMade: job.attemptsMade },
      `[${name}] job started`
    );
  });

  worker.on('completed', (job) => {
    if (!job) return;
    getLogger().debug(
      { jobId: String(job.id), ...extractJobMeta(job.data as Record<string, unknown>) },
      `[${name}] job completed`
    );
  });

  worker.on('failed', (job, err) => {
    if (!job || !err) return;
    getLogger().error(
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

  worker.on('stalled', (jobId) => {
    getLogger().warn(
      { jobId, queueName: name },
      `[${name}] Job stalled - lock may have expired. This typically happens when a job takes longer than the lock duration (default: 30s). Check if event loop is blocked.`
    );
  });

  worker.on('error', (err) => {
    const details = extractErrorDetails(err);
    getLogger().error({ workerName: name, err: details }, `[${name}] worker error`);
  });

  workerRegistry.register(name, worker as Worker);
  getLogger().info({ name }, 'Worker created');

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
