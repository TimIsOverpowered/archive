import Redis from 'ioredis';
import { RedisService } from '../utils/redis-service.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { configService } from './tenant-config.js';

const CONFIG_CHANNEL = 'cache:tenant';

interface ConfigChangeEvent {
  type: 'TENANT_CONFIG_CHANGED';
  tenantId: string;
}

/**
 * Handle a parsed config change event by reloading the tenant from the database.
 * Fire-and-forget from the Redis message listener; errors are caught and logged.
 */
async function handleConfigEvent(event: ConfigChangeEvent): Promise<void> {
  await configService.reloadTenant(event.tenantId);
}

/**
 * Create and subscribe a Redis Pub/Sub client for tenant config invalidation events.
 * Returns the subscriber client for manual cleanup.
 */
function createTenantConfigSubscriber(): Redis {
  const mainClient = RedisService.getActiveClient();
  if (!mainClient) {
    throw new Error('Redis client not available for tenant config subscriber');
  }

  const subClient = mainClient.duplicate();
  const log = getLogger().child({ module: 'tenant-config-subscriber' });

  subClient.on('error', (err) => {
    log.warn({ err: extractErrorDetails(err) }, 'Tenant config subscriber client error');
  });

  subClient.on('subscribe', (channel) => {
    log.debug({ channel }, 'Tenant config subscriber connected');
  });

  subClient.on('unsubscribe', (channel) => {
    log.debug({ channel }, 'Tenant config subscriber disconnected');
  });

  subClient.on('reconnect', () => {
    log.warn('Tenant config subscriber redis reconnecting, re-subscribing');
    void subClient.subscribe(CONFIG_CHANNEL);
  });

  subClient.on('message', (_channel: string, message: string) => {
    if (_channel !== CONFIG_CHANNEL) return;

    let event: ConfigChangeEvent;
    try {
      event = JSON.parse(message) as ConfigChangeEvent;
    } catch {
      log.warn({ message }, 'Failed to parse tenant config event');
      return;
    }

    void handleConfigEvent(event).catch((error) => {
      const details = extractErrorDetails(error);
      log.warn({ err: details, event }, 'Failed to process tenant config event');
    });
  });

  void subClient.subscribe(CONFIG_CHANNEL);

  return subClient;
}

/**
 * Register a Redis Pub/Sub subscriber for tenant config invalidation events.
 * When a worker updates a tenant's auth token in the database, it publishes an
 * event on the config channel. This subscriber reloads the affected tenant from
 * the database, keeping the in-memory cache in sync across processes.
 *
 * Hooks into fastify's onClose for cleanup.
 */
export function registerTenantConfigSubscriber(fastify: { addHook: (hook: string, fn: () => Promise<void>) => void }): void {
  const subClient = createTenantConfigSubscriber();
  const log = getLogger().child({ module: 'tenant-config-subscriber' });

  fastify.addHook('onClose', async () => {
    try {
      await subClient.unsubscribe(CONFIG_CHANNEL);
    } finally {
      await subClient.quit();
    }
    log.debug('Tenant config subscriber disconnected');
  });
}

/**
 * Register a Redis Pub/Sub subscriber for tenant config invalidation events.
 * Returns the subscriber client for manual cleanup on shutdown.
 * Used by workers that don't have a Fastify lifecycle.
 */
export function registerTenantConfigSubscriberWorker(): Redis {
  return createTenantConfigSubscriber();
}
