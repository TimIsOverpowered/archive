import Redis from 'ioredis';
import { createRedisSubscriber } from '../utils/redis-subscriber.js';
import { configService } from './tenant-config.js';

const CONFIG_CHANNEL = 'cache:tenant';

interface ConfigChangeEvent {
  type: 'TENANT_CONFIG_CHANGED';
  tenantId: string;
}

async function handleConfigEvent(event: ConfigChangeEvent): Promise<void> {
  await configService.reloadTenant(event.tenantId);
}

export function registerTenantConfigSubscriber(fastify: {
  addHook: (hook: string, fn: () => Promise<void>) => void;
}): void {
  const { destroy } = createRedisSubscriber({
    channel: CONFIG_CHANNEL,
    handler: handleConfigEvent,
    loggerModule: 'tenant-config-subscriber',
  });

  fastify.addHook('onClose', destroy);
}

export function registerTenantConfigSubscriberWorker(): Redis {
  const { client } = createRedisSubscriber({
    channel: CONFIG_CHANNEL,
    handler: handleConfigEvent,
    loggerModule: 'tenant-config-subscriber',
  });
  return client;
}
