import { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { configService } from '../../config/tenant-config.js';
import { getClient } from '../../db/streamer-client.js';
import { checkFlareSolverrHealth } from '../../utils/flaresolverr-health.js';
import { getCachedRangeInfo } from '../../utils/cloudflare-ip-validator.js';
import healthCheckMiddleware from '../middleware/health-check.js';
import { RedisService } from '../../utils/redis-service.js';
import { getCacheMetrics } from '../../utils/cache.js';
import { QUEUE_NAMES } from '../../workers/queues/queue.js';
import type { QueueJob } from '../../workers/queues/types.js';
import { getRedisInstance } from '../../workers/redis.js';
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
      const streamerConfigs = await configService.loadAll();
      const redisStatusInfo = RedisService.getStatus();

      let redisStatus = 'ok';
      try {
        await redis.ping();
        if (redisStatusInfo.status !== 'ready') {
          redisStatus = 'unstable';
        }
      } catch {
        redisStatus = 'error';
      }

      const streamers = [];
      const dbStatuses = { ok: 0, error: 0, uninitialized: 0 };
      for (const config of streamerConfigs) {
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

        dbStatuses[dbStatus as 'ok' | 'error' | 'uninitialized']++;
        streamers.push({
          id: config.id,
          db: dbStatus,
        });
      }

      const kickConfig = streamerConfigs.find((c) => c.kick?.enabled === true);
      const flaresolverrHealth = await checkFlareSolverrHealth();

      let cloudflareCache = { status: 'unknown' };
      try {
        const cfInfo = await getCachedRangeInfo();
        cloudflareCache = cfInfo ?? { status: 'missing' };
      } catch {
        cloudflareCache = { status: 'error' };
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
        ...(kickConfig && {
          kick: {
            flaresolverr: flaresolverrHealth.status,
            version: flaresolverrHealth.stats.version,
          },
        }),
        cache: getCacheMetrics(),
        workerQueues,
      });

      return response;
    }
  );
}

/** Fetch job counts for all registered worker queues. */
async function getQueueMetrics(): Promise<
  Record<string, { waiting: number; active: number; failed: number; delayed: number }>
> {
  const result: Record<string, { waiting: number; active: number; failed: number; delayed: number }> = {};
  try {
    const redis = getRedisInstance();
    for (const queueName of Object.values(QUEUE_NAMES)) {
      const queue = new Queue<QueueJob, QueueJob, string>(queueName, { connection: redis });
      try {
        const counts = await queue.getJobCounts();
        result[queueName] = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          delayed: counts.delayed ?? 0,
        };
      } catch {
        result[queueName] = { waiting: -1, active: -1, failed: -1, delayed: -1 };
      }
    }
  } catch {
    // Redis unavailable — return empty metrics
  }
  return result;
}
