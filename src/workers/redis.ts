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

// Wait for ready event with timeout (register BEFORE connect)
const readyTimeout = 30000;
let readyResolved = false;

const readyHandler = () => {
  if (readyResolved) return;
  readyResolved = true;
  clearTimeout(timeoutId);
  logger.info('[Workers Redis] Connection ready - BullMQ can now process jobs');
};

const timeoutId = setTimeout(() => {
  redisInstance.off('ready', readyHandler);
  const errorMsg = `Redis did not become ready after ${readyTimeout}ms`;
  logger.fatal({ timeoutMs: readyTimeout }, errorMsg);
}, readyTimeout);

const readyPromise: Promise<void> = new Promise<void>((resolve, _) => {
  redisInstance.on('ready', readyHandler);
  resolve(); // Will be called by readyHandler
});

// Connection event handlers using project logger
redisInstance.on('error', (err) => {
  logger.error({ err: err.message }, '[Workers Redis] Connection error');
});

redisInstance.on('connect', () => {
  logger.info('[Workers Redis] Connected to Redis server');
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
  }
}

// Export connection status checker for health checks
export function isRedisReady(): boolean {
  return redisInstance.status === 'ready';
}

// Export readyPromise for bootstrap to await
export { readyPromise as waitForRedisReady };
