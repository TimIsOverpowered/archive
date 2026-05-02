import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { getLogger } from './logger.js';
import { extractErrorDetails } from './error.js';
import { getBaseConfig } from '../config/env.js';
import { clearAllConnectionFailures } from './cache-state.js';

/** Configuration for a rate limiter instance. */
export interface RateLimiterConfig {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration?: number | undefined;
}

/** Options for initializing the Redis service singleton. */
export interface RedisServiceOptions {
  url: string;
  rateLimiters?: RateLimiterConfig[];
  maxRetriesPerRequest?: number | null;
}

interface RateLimiterInstance {
  limiter: RateLimiterRedis | RateLimiterMemory;
  isFallback: boolean;
}

/**
 * Singleton managing Redis connection and rate limiter instances.
 * Supports in-memory fallback when Redis is unavailable in non-production.
 */
export class RedisService {
  private static _instance: RedisService | null = null;

  private client: Redis | null = null;
  private limiters: Map<string, RateLimiterInstance> = new Map();
  private isProduction: boolean;
  private _options: RedisServiceOptions | null = null;

  private constructor() {
    this.isProduction = getBaseConfig().NODE_ENV === 'production';
  }

  static get instance(): RedisService | null {
    return this._instance;
  }

  static init(options: RedisServiceOptions): RedisService {
    if (this._instance) {
      getLogger().warn('RedisService.init() called on already-initialized instance — ignoring');
      return this._instance;
    }
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

  static getActiveClient(): Redis | null {
    if (getBaseConfig().DISABLE_REDIS_CACHE) return null;
    return this._instance?.client ?? null;
  }

  static getLimiter(key: string): RateLimiterRedis | RateLimiterMemory | null {
    if (!this._instance) return null;
    const entry = this._instance.limiters.get(key);
    if (!entry) return null;
    return entry.limiter;
  }

  static requireLimiter(key: string): RateLimiterRedis | RateLimiterMemory {
    const limiter = this.getLimiter(key);
    if (!limiter) {
      throw new Error(`Rate limiter '${key}' not initialized. Ensure RedisService.init() was called with this key in rateLimiters config.`);
    }
    return limiter;
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
    getLogger().info({ url: maskedUrl }, 'Connecting to Redis');

    const maxRetries = this.isProduction ? 5 : 3;

    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest,
      retryStrategy(times: number) {
        if (times > maxRetries) {
          getLogger().error({ times }, 'Redis max connection retries exceeded. Giving up.');
          return null;
        }
        const delay = Math.min(times * 500, 2000);
        getLogger().warn({ times, delay }, 'Redis reconnection attempt');
        return delay;
      },
    });

    try {
      await this.client.connect();
      getLogger().info('Redis connection established');

      this.client.on('ready', () => {
        getLogger().info('Redis connection ready, clearing cached failure flags');
        clearAllConnectionFailures();
      });
    } catch (error) {
      if (this.isProduction) {
        const details = extractErrorDetails(error);
        getLogger().fatal(
          { error: details.message },
          'Failed to connect to Redis - server cannot start in production without Redis'
        );
        throw error;
      }

      const details = extractErrorDetails(error);
      getLogger().warn(
        { error: details.message },
        'Redis connection failed - running with in-memory rate limiters (caching disabled)'
      );

      this.client = null;

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
        getLogger().info({ count: rateLimiters.length }, 'In-memory fallback rate limiters initialized');
        return;
      }
      return;
    }

    // Initialize rate limiters
    if (rateLimiters && rateLimiters.length > 0) {
      for (const rlConfig of rateLimiters) {
        this.limiters.set(rlConfig.keyPrefix, {
          limiter: new RateLimiterRedis({
            storeClient: this.client,
            keyPrefix: rlConfig.keyPrefix,
            points: rlConfig.points,
            duration: rlConfig.duration,
            ...(rlConfig.blockDuration !== undefined && { blockDuration: rlConfig.blockDuration }),
          }),
          isFallback: false,
        });
      }
      getLogger().info({ count: rateLimiters.length }, 'Rate limiters initialized');
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
        getLogger().info('Redis client closed');
      } catch (error) {
        const details = extractErrorDetails(error);
        getLogger().warn({ error: details.message }, 'Error closing Redis client during shutdown');
      } finally {
        this.client = null;
      }
    }
  }
}
