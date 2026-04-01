import { createClient, RedisClientType } from 'redis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { logger } from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify';

interface RedisPluginOptions {
  url: string;
}

export let redisClient: RedisClientType | null = null;
export let publicRateLimiter: RateLimiterRedis | null = null;
export let chatRateLimiter: RateLimiterRedis | null = null;
export let adminRateLimiter: RateLimiterRedis | null = null;

const redisPlugin: FastifyPluginAsync<RedisPluginOptions> = async (fastify, options) => {
  const { url } = options;

  const maskedUrl = url.replace(/:\/\/.*@/, '://***@');
  logger.info({ url: maskedUrl }, 'Connecting to Redis');

  const isProduction = process.env.NODE_ENV === 'production';
  let errorCount = 0;
  let connectCount = 0;
  const maxErrorsBeforeFail = isProduction ? 5 : 3;
  const readyTimeout = isProduction ? 30000 : 10000;

  try {
    redisClient = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) return new Error('Max Redis reconnection attempts reached');
          const delay = Math.min(retries * 500, 5000);
          logger.warn({ retries, delay }, 'Redis reconnection attempt');
          return delay;
        },
      },
    });

    if (!redisClient) {
      logger.error('Redis client not initialized');
      throw new Error('Redis client initialization failed');
    }

    redisClient.on('error', (err) => {
      errorCount++;
      logger.error({ err: err.message, errorCount }, 'Redis connection error');

      if (errorCount >= maxErrorsBeforeFail) {
        const errorMsg = `Redis connection unstable after ${errorCount} errors`;
        redisClient?.quit().catch(() => {});
        throw new Error(errorMsg);
      }
    });

    redisClient.on('connect', () => {
      connectCount++;
      if (errorCount === 0) {
        logger.info('Redis connected');
      }
    });

    // Wait for ready event with timeout (register BEFORE connect)
    let readyResolved = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        redisClient?.off('ready', readyHandler);
        const errorMsg = `Redis did not become ready after ${readyTimeout}ms (${errorCount} errors, ${connectCount} connects)`;
        logger.error({ errorCount, connectCount }, errorMsg);
        reject(new Error(errorMsg));
      }, readyTimeout);

      const readyHandler = () => {
        if (readyResolved) return;
        readyResolved = true;
        clearTimeout(timeoutId);
        logger.info('Redis client ready - connection stable');
        resolve();
      };

      redisClient?.on('ready', readyHandler);
    });

    // Add timeout to connection attempt
    logger.info('Attempting Redis connection...');

    const connectPromise = redisClient.connect();
    await connectPromise;

    if (!redisClient) {
      logger.error('Redis client became null after connection');
      throw new Error('Redis client lost during connection');
    }

    await readyPromise;
    logger.info('Redis connection established');

    fastify.decorate('redis', redisClient);

    // Initialize rate limiters from env vars
    const vodLimit = parseInt(process.env.RATE_LIMIT_VODS || '60', 10);
    const chatLimit = parseInt(process.env.RATE_LIMIT_CHAT || '30', 10);
    const adminGetLimit = parseInt(process.env.RATE_LIMIT_ADMIN_GET || '60', 10);
    const blockDuration = parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '60', 10);

    publicRateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rate:vods',
      points: vodLimit,
      duration: 60,
      blockDuration: blockDuration,
    });
    fastify.decorate('publicRateLimiter', publicRateLimiter);

    chatRateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rate:chat',
      points: chatLimit,
      duration: 60,
      blockDuration: blockDuration * 2,
    });
    fastify.decorate('chatRateLimiter', chatRateLimiter);

    adminRateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: 'rate:admin',
      points: adminGetLimit,
      duration: 60,
      blockDuration: blockDuration * 5,
    });
    fastify.decorate('adminRateLimiter', adminRateLimiter);

    logger.info({ vodLimit, chatLimit, adminGetLimit }, 'Rate limiters initialized');
  } catch (error) {
    const isProduction = process.env.NODE_ENV === 'production';
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (isProduction) {
      logger.fatal({ error: errorMessage }, 'Failed to connect to Redis - server cannot start in production without Redis');
      throw error;
    }

    logger.warn({ error: errorMessage }, 'Redis connection failed - running without Redis (rate limiting and caching disabled)');

    // Create mock/no-op implementations for development
    const mockRedis = {
      ping: async () => 'PONG',
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
      getBuffer: async () => null,
      setBuffer: async () => 'OK',
    } as unknown as RedisClientType;

    // Mock rate limiters (always allow in dev without Redis)
    const mockLimiter = {
      consume: async () => ({ remainingPoints: 100 }),
      points: 100,
      duration: 60,
    } as unknown as RateLimiterRedis;

    fastify.decorate('redis', mockRedis);
    fastify.decorate('publicRateLimiter', mockLimiter);
    fastify.decorate('chatRateLimiter', mockLimiter);
    fastify.decorate('adminRateLimiter', mockLimiter);
  }
};

export default redisPlugin;

/**
 * Gracefully close Redis client connection during shutdown
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info('Redis client closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn({ error: errorMessage }, 'Error closing Redis client during shutdown');
    } finally {
      redisClient = null;
    }
  }
}
