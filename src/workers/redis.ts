import Redis, { RedisOptions } from 'ioredis';
import { logger } from '../utils/logger.js';

// Eagerly created singleton ioredis instance for all BullMQ operations
const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ workers
  retryStrategy(times: number) {
    if (times > 10) return null; // Give up after 10 attempts
    const delay = Math.min(times * 500, 5000);
    logger.warn({ times, delay }, '[Workers Redis] Reconnection attempt');
    return delay;
  },
};

const redisInstance = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', redisOptions);

// Connection event handlers using project logger
redisInstance.on('error', (err) => {
  logger.error({ err: err.message }, '[Workers Redis] Connection error');
});

redisInstance.on('connect', () => {
  logger.info('[Workers Redis] Connected to Redis server');
});

redisInstance.on('ready', () => {
  logger.info('[Workers Redis] Connection ready - BullMQ can now process jobs');
});

redisInstance.on('close', () => {
  logger.info('[Workers Redis] Connection closed');
});

// Export the singleton instance
export { redisInstance };

// Export close function for graceful shutdown
export async function closeWorkersRedis(): Promise<void> {
  if (redisInstance.status === 'ready' || redisInstance.status === 'connecting') {
    logger.info('[Workers Redis] Closing connection...');
    await redisInstance.quit();
    logger.info('[Workers Redis] Connection closed');
  }
}

// Export connection status checker for health checks
export function isRedisReady(): boolean {
  return redisInstance.status === 'ready';
}

// Wait for Redis to be ready with timeout
export async function waitForRedisReady(timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();

  logger.info('[Workers] Waiting for Redis connection to be ready...');

  while (!isRedisReady()) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= timeoutMs) {
      logger.fatal({ timeoutMs, elapsed, status: redisInstance.status }, '[Workers] Redis connection timeout - workers cannot start without Redis');
      throw new Error(`Redis did not become ready within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info('[Workers] Redis connection is ready');
}
