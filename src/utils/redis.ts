import Redis from 'ioredis';
import { logger } from './logger.js';
import { extractErrorDetails } from './error.js';
import { sleep } from './delay.js';

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

      const details = extractErrorDetails(error);
      logger.info({ ...details, attempt, maxAttempts, delay: delay / 1000 }, 'Redis connection failed');
      await sleep(delay);
      delay *= 2;
    }
  }

  throw new Error('Failed to connect to Redis after all attempts');
}
