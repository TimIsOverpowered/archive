import { getWorkersConfig } from '../config/env.ts';
import { Kick } from '../constants.ts';
import { RedisService } from '../utils/redis-service.ts';

let initPromise: Promise<void> | null = null;

export function getRedisInstance() {
  return RedisService.getClient();
}

export async function initWorkersRedis(): Promise<void> {
  if (RedisService.instance) return;
  if (initPromise !== null) return initPromise;

  initPromise = (async () => {
    const url = getWorkersConfig().REDIS_URL;
    await RedisService.init({
      url,
      maxRetriesPerRequest: null,
      rateLimiters: [
        {
          keyPrefix: 'rate:kick:chat',
          points: Kick.CHAT_FETCH_LIMIT_POINTS,
          duration: Kick.CHAT_FETCH_LIMIT_DURATION_S,
        },
      ],
    }).connect();
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
