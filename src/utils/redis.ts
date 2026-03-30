import Redis from 'ioredis';
import { logger } from './logger.js';

export async function connectWithBackoff(url: string, maxAttempts = 6): Promise<Redis> {
  let attempt = 0;
  let delay = 2000;

  while (attempt < maxAttempts) {
    try {
      const client = new Redis(url);

      await client.ping();

      return client;
    } catch (error) {
      attempt++;
      if (attempt >= maxAttempts) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.info({ attempt, maxAttempts, delay: delay / 1000 }, `Redis connection failed: ${errorMessage}, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error('Failed to connect to Redis after all attempts');
}
