import type { Redis } from 'ioredis';
import { extractErrorDetails } from './error.js';
import { getLogger } from './logger.js';
import { RedisService } from './redis-service.js';

export interface RedisSubscriberOptions<TEvent> {
  channel: string;
  handler: (event: TEvent) => Promise<void>;
  loggerModule?: string;
}

export function createRedisSubscriber<TEvent>(options: RedisSubscriberOptions<TEvent>): {
  client: Redis;
  destroy: () => Promise<void>;
} {
  const mainClient = RedisService.getActiveClient();
  if (!mainClient) {
    throw new Error('Redis client not available for subscriber');
  }

  const subClient = mainClient.duplicate();
  const log = getLogger().child({ module: options.loggerModule ?? 'redis-subscriber' });

  subClient.on('error', (err) => {
    log.warn({ err: extractErrorDetails(err) }, 'Redis subscriber client error');
  });

  subClient.on('subscribe', (channel) => {
    log.debug({ channel }, 'Redis subscriber connected');
  });

  subClient.on('unsubscribe', (channel) => {
    log.debug({ channel }, 'Redis subscriber disconnected');
  });

  subClient.on('reconnect', () => {
    log.warn('Redis subscriber reconnecting, re-subscribing');
    void subClient.subscribe(options.channel);
  });

  subClient.on('message', (channel: string, message: string) => {
    if (channel !== options.channel) return;

    let event: TEvent;
    try {
      event = JSON.parse(message) as TEvent;
    } catch {
      log.warn({ message }, 'Failed to parse Redis event');
      return;
    }

    void options.handler(event).catch((error) => {
      const details = extractErrorDetails(error);
      log.warn({ err: details, event }, 'Failed to process Redis event');
    });
  });

  void subClient.subscribe(options.channel);

  return {
    client: subClient,
    destroy: async () => {
      try {
        await subClient.unsubscribe(options.channel);
      } finally {
        await subClient.quit();
      }
      log.debug('Redis subscriber disconnected');
    },
  };
}
