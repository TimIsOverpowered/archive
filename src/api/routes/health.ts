import { Queue } from 'bullmq';
import { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { getBaseConfig } from '../../config/env.js';
import { configService } from '../../config/tenant-config.js';
import { Server } from '../../constants.js';
import { getClient } from '../../db/streamer-client.js';
import { defaultCacheContext } from '../../utils/cache.js';
import { getCachedRangeInfo } from '../../utils/cloudflare-ip-validator.js';
import { checkFlareSolverrHealth } from '../../utils/flaresolverr-health.js';
import { RedisService } from '../../utils/redis-service.js';
import { QUEUE_NAMES } from '../../workers/queues/queue.js';
import { getRedisInstance } from '../../workers/redis.js';
import type { AllJobData } from '../../workers/worker-definitions.js';
import healthCheckMiddleware from '../middleware/health-check.js';
import { ok } from '../response.js';

/** Options for registering the health routes plugin. */
interface HealthRouteOptions {
  prefix: string;
}

/**
 * Register health check endpoint: reports Redis, DB, streamer, queue, and cache status.
 * Requires x-health-token header for timing-safe validation.
 */
export default function healthRoutes(fastify: FastifyInstance, _options: HealthRouteOptions) {
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        description: 'Health check endpoint for monitoring',
        headers: {
          type: 'object',
          properties: {
            'x-health-token': { type: 'string', description: 'Health check token' },
          },
          required: ['x-health-token'],
        },
      },
      onRequest: healthCheckMiddleware,
    },
    async () => {
      const redis = fastify.redis;
      const [streamerConfigs, redisStatusInfo] = await Promise.all([
        configService.loadAll(),
        Promise.resolve(RedisService.getStatus()),
      ]);

      let redisStatus = 'ok';
      try {
        await raceWithTimeout(redis.ping(), Server.HEALTH_TIMEOUT_MS, 'Redis ping');
        if (redisStatusInfo.status !== 'ready') {
          redisStatus = 'unstable';
        }
      } catch {
        redisStatus = 'error';
      }

      const streamers = [];
      const dbStatuses = { ok: 0, error: 0, uninitialized: 0 };

      const dbChecks = streamerConfigs.map(async (config) => {
        const client = getClient(config.id);
        let dbStatus = 'uninitialized';

        if (client) {
          dbStatus = 'ok';
          try {
            await sql`SELECT 1`.execute(client);
          } catch {
            dbStatus = 'error';
          }
        }

        return { id: config.id, db: dbStatus };
      });

      const streamerResults = await Promise.all(dbChecks);

      for (const result of streamerResults) {
        dbStatuses[result.db as 'ok' | 'error' | 'uninitialized']++;
        streamers.push(result);
      }

      const flaresolverrHealth = await checkFlareSolverrHealth();

      let cloudflareCache: { status: string } = { status: 'disabled' };
      if (getBaseConfig().REQUIRE_CLOUDFLARE_IP) {
        try {
          const cfInfo = await getCachedRangeInfo();
          cloudflareCache = cfInfo ?? { status: 'missing' };
        } catch {
          cloudflareCache = { status: 'error' };
        }
      }

      const rateLimiters = {
        vods: { fallback: RedisService.isLimiterFallback('rate:vods') },
        chat: { fallback: RedisService.isLimiterFallback('rate:chat') },
        admin: { fallback: RedisService.isLimiterFallback('rate:admin') },
      };

      const workerQueues = await getQueueMetrics();

      const response = ok({
        status: redisStatus === 'error' ? 'degraded' : 'ok',
        uptime: process.uptime(),
        redis: {
          status: redisStatus,
          connection: redisStatusInfo.status,
          connected: redisStatusInfo.connected,
        },
        rateLimiters,
        streamers,
        dbStatuses,
        cloudflareIpCache: cloudflareCache,
        flaresolverr: flaresolverrHealth,
        cache: defaultCacheContext.getMetrics(),
        workerQueues,
      });

      return response;
    }
  );
}

/** Race a promise against a timeout. */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Fetch job counts for all registered worker queues. */
async function getQueueMetrics(): Promise<
  Record<string, { waiting: number; active: number; failed: number; delayed: number }>
> {
  const result: Record<string, { waiting: number; active: number; failed: number; delayed: number }> = {};
  try {
    const redis = getRedisInstance();
    const queueChecks = Object.values(QUEUE_NAMES).map(async (queueName) => {
      const queue = new Queue<AllJobData, AllJobData, string>(queueName, { connection: redis });
      try {
        const counts = await raceWithTimeout(queue.getJobCounts(), 10_000, `Queue metrics ${queueName}`);
        return [
          queueName,
          {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            failed: counts.failed ?? 0,
            delayed: counts.delayed ?? 0,
          },
        ] as const;
      } catch {
        return [queueName, { waiting: -1, active: -1, failed: -1, delayed: -1 }] as const;
      }
    });

    const queueResults = await Promise.all(queueChecks);
    for (const [name, metrics] of queueResults) {
      result[name] = metrics;
    }
  } catch {
    // Redis unavailable — return empty metrics
  }
  return result;
}
