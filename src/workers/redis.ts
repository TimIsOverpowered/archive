import { RedisService } from '../utils/redis-service.js';
import { logger } from '../utils/logger.js';

let initPromise: Promise<void> | null = null;

export function getRedisInstance() {
  return RedisService.getClient();
}

export async function initWorkersRedis(): Promise<void> {
  if (RedisService.instance) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { getWorkersConfig } = await import('../config/env.js');
    const url = getWorkersConfig().REDIS_URL;
    const maskedUrl = url.replace(/:\/\/.*@/, '://***@');
    logger.info({ url: maskedUrl }, '[Workers Redis] Connecting to Redis');

    RedisService.init({ url, maxRetriesPerRequest: null });

    await RedisService.instance!.connect();
  })();

  return initPromise;
}

export async function waitForRedisReady(): Promise<void> {
  if (!initPromise) throw new Error('Call initWorkersRedis() first');
  return initPromise;
}

export async function closeWorkersRedis(): Promise<void> {
  await RedisService.close();
}

export function isRedisReady(): boolean {
  const status = RedisService.getStatus();
  return status.connected;
}
