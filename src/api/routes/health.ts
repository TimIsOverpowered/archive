import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { loadStreamerConfigs } from '../../config/loader';
import { getClient } from '../../db/client';
import { checkPuppeteerHealth } from '../../utils/puppeteer-health';
import { getCachedRangeInfo } from '../../utils/cloudflare-ip-validator';
import healthCheckMiddleware from '../middleware/health-check';

interface HealthRouteOptions {
  prefix: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    getAllConfigs: () => Promise<unknown[]>;
  }
}

export default async function healthRoutes(fastify: FastifyInstance, _options: HealthRouteOptions) {
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
      const streamerConfigs = await loadStreamerConfigs();

      let redisStatus = 'ok';
      try {
        await redis.ping();
      } catch {
        redisStatus = 'error';
      }

      const streamers = [];
      for (const config of streamerConfigs) {
        const client = getClient(config.id);
        let dbStatus = 'ok';

        if (client) {
          try {
            await client.$queryRaw`SELECT 1`;
          } catch {
            dbStatus = 'error';
          }
        }

        streamers.push({
          id: config.id,
          db: dbStatus,
        });
      }

      const kickConfig = streamerConfigs.find((c) => c.kick?.enabled);
      const puppeteerHealth = await checkPuppeteerHealth();

      let cloudflareCache = { status: 'unknown' };
      try {
        const cfInfo = await getCachedRangeInfo();
        cloudflareCache = cfInfo || { status: 'missing' };
      } catch {
        cloudflareCache = { status: 'error' };
      }

      let workersStatus;
      try {
        const workersModule = await import('../../workers/index');

        if (typeof workersModule.getWorkersHealth === 'function') {
          workersStatus = await workersModule.getWorkersHealth();
        } else {
          workersStatus = {};
        }
      } catch {
        workersStatus = {};
      }

      const response = {
        data: {
          status: 'ok',
          redis: redisStatus,
          streamers,
          workers: workersStatus,
          cloudflareIpCache: cloudflareCache,
          ...(kickConfig && {
            kick: {
              puppeteer: puppeteerHealth.status,
              memoryStats: puppeteerHealth.stats,
            },
          }),
        },
      };

      return response;
    }
  );
}
