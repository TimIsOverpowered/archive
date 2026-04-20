import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { sql } from 'kysely';
import { loadTenantConfigs } from '../../config/loader.js';
import { getClient } from '../../db/client.js';
import { checkPuppeteerHealth } from '../../utils/puppeteer-health.js';
import { getCachedRangeInfo } from '../../utils/cloudflare-ip-validator.js';
import healthCheckMiddleware from '../middleware/health-check.js';
import { RedisService } from '../../utils/redis-service.js';

interface HealthRouteOptions {
  prefix: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
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
      const streamerConfigs = await loadTenantConfigs();
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

      const kickConfig = streamerConfigs.find((c) => c.kick?.enabled);
      const puppeteerHealth = await checkPuppeteerHealth();

      let cloudflareCache = { status: 'unknown' };
      try {
        const cfInfo = await getCachedRangeInfo();
        cloudflareCache = cfInfo || { status: 'missing' };
      } catch {
        cloudflareCache = { status: 'error' };
      }

      const rateLimiters = {
        vods: { fallback: RedisService.isLimiterFallback('rate:vods') },
        chat: { fallback: RedisService.isLimiterFallback('rate:chat') },
        admin: { fallback: RedisService.isLimiterFallback('rate:admin') },
      };

      const response = {
        data: {
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
