import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { logger } from './logger.js';
import { extractErrorDetails } from './error.js';

export interface RateLimiterConfig {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration?: number;
}

export interface RedisServiceOptions {
  url: string;
  rateLimiters?: RateLimiterConfig[];
  maxRetriesPerRequest?: number | null;
}

interface RateLimiterInstance {
  limiter: RateLimiterRedis | RateLimiterMemory;
  isFallback: boolean;
}

export class RedisService {
  private static _instance: RedisService | null = null;

  private client: Redis | null = null;
  private limiters: Map<string, RateLimiterInstance> = new Map();
  private isProduction: boolean;
  private _options: RedisServiceOptions | null = null;

  private constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  static get instance(): RedisService | null {
    return this._instance;
  }

  static init(options: RedisServiceOptions): RedisService {
    if (this._instance) return this._instance;
    this._instance = new RedisService();
    this._instance._options = options;
    return this._instance;
  }

  static getClient(): Redis {
    if (!this._instance?.client) {
      throw new Error('RedisService not initialized. Call RedisService.init() first.');
    }
    return this._instance.client;
  }

  static getLimiter(key: string): RateLimiterRedis | RateLimiterMemory | null {
    if (!this._instance) return null;
    const entry = this._instance.limiters.get(key);
    if (!entry) return null;
    return entry.limiter;
  }

  static getStatus(): { status: string; connected: boolean } {
    if (!this._instance?.client) {
      return { status: 'not-initialized', connected: false };
    }
    return {
      status: this._instance.client.status,
      connected: this._instance.client.status === 'ready',
    };
  }

  static isLimiterFallback(key: string): boolean {
    if (!this._instance) return false;
    return this._instance.isLimiterFallback(key);
  }

  static close(): Promise<void> {
    if (!this._instance) return Promise.resolve();
    const instance = this._instance;
    this._instance = null;
    return instance.close();
  }

  async connect(): Promise<void> {
    if (!this._options) {
      throw new Error('RedisService options not provided. Call RedisService.init() first.');
    }

    const { url, rateLimiters, maxRetriesPerRequest } = this._options;
    const maskedUrl = url.replace(/:\/\/.*@/, '://***@');
    logger.info({ url: maskedUrl }, 'Connecting to Redis');

    let errorCount = 0;
    const maxErrorsBeforeFail = this.isProduction ? 5 : 3;
    const readyTimeout = this.isProduction ? 30000 : 10000;

    try {
      this.client = new Redis(url, {
        maxRetriesPerRequest,
        retryStrategy(times: number) {
          if (times > 10) return null;
          const delay = Math.min(times * 500, 5000);
          logger.warn({ times, delay }, 'Redis reconnection attempt');
          return delay;
        },
      });

      if (!this.client) {
        logger.error('Redis client not initialized');
        throw new Error('Redis client initialization failed');
      }

      this.client.on('error', (err) => {
        errorCount++;
        logger.error({ err: err.message, errorCount }, 'Redis connection error');

        if (errorCount >= maxErrorsBeforeFail) {
          const errorMsg = `Redis connection unstable after ${errorCount} errors`;
          this.client?.quit().catch(() => {});
          throw new Error(errorMsg);
        }
      });

      this.client.on('connect', () => {
        if (errorCount === 0) {
          logger.info('Redis connected');
        }
      });

      let readyResolved = false;
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.client?.off('ready', readyHandler);
          const errorMsg = `Redis did not become ready after ${readyTimeout}ms (${errorCount} errors)`;
          logger.error({ errorCount }, errorMsg);
          reject(new Error(errorMsg));
        }, readyTimeout);

        const readyHandler = () => {
          if (readyResolved) return;
          readyResolved = true;
          clearTimeout(timeoutId);
          logger.info('Redis client ready - connection stable');
          resolve();
        };

        this.client?.on('ready', readyHandler);
      });

      await readyPromise;
      logger.info('Redis connection established');

      // Initialize rate limiters
      if (rateLimiters && rateLimiters.length > 0) {
        for (const rlConfig of rateLimiters) {
          this.limiters.set(rlConfig.keyPrefix, {
            limiter: new RateLimiterRedis({
              storeClient: this.client,
              keyPrefix: rlConfig.keyPrefix,
              points: rlConfig.points,
              duration: rlConfig.duration,
              blockDuration: rlConfig.blockDuration,
            }),
            isFallback: false,
          });
        }
        logger.info({ count: rateLimiters.length }, 'Rate limiters initialized');
      }
    } catch (error) {
      if (this.isProduction) {
        const details = extractErrorDetails(error);
        logger.fatal(
          { error: details.message },
          'Failed to connect to Redis - server cannot start in production without Redis'
        );
        throw error;
      }

      const details = extractErrorDetails(error);
      logger.warn(
        { error: details.message },
        'Redis connection failed - running with in-memory rate limiters (caching disabled)'
      );

      // Initialize in-memory fallback rate limiters
      if (rateLimiters && rateLimiters.length > 0) {
        for (const rlConfig of rateLimiters) {
          this.limiters.set(rlConfig.keyPrefix, {
            limiter: new RateLimiterMemory({
              points: rlConfig.points,
              duration: rlConfig.duration,
            }),
            isFallback: true,
          });
        }
        logger.info({ count: rateLimiters.length }, 'In-memory fallback rate limiters initialized');
      }
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  getLimiter(key: string): RateLimiterRedis | RateLimiterMemory | null {
    const entry = this.limiters.get(key);
    return entry?.limiter ?? null;
  }

  isLimiterFallback(key: string): boolean {
    const entry = this.limiters.get(key);
    return entry?.isFallback ?? false;
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('Redis client closed');
      } catch (error) {
        const details = extractErrorDetails(error);
        logger.warn({ error: details.message }, 'Error closing Redis client during shutdown');
      } finally {
        this.client = null;
      }
    }
  }
}
