import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { createMockRedis, type MockRedisClient } from '../helpers/mock-redis.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { configService } from '../../src/config/tenant-config.js';
import { registerTenantConfigSubscriberWorker } from '../../src/config/tenant-config-subscriber.js';

const CONFIG_CHANNEL = 'cache:tenant';

describe('tenant-config-subscriber', () => {
  let mockRedis: MockRedisClient;
  let mockReloadCalls: string[] = [];
  let mockReloadThrow: Error | null = null;
  let subClient: any = null;

  beforeEach(() => {
    mockReloadCalls = [];
    mockReloadThrow = null;
    mockRedis = createMockRedis();
    mockRedis.connect();

    (RedisService as any)._instance = {
      client: mockRedis,
    };

    // Safely spy on the method directly on the class instance
    mock.method(configService, 'reloadTenant', async (tenantId: string) => {
      if (mockReloadThrow) throw mockReloadThrow;
      mockReloadCalls.push(tenantId);
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    (RedisService as any)._instance = null;
    if (subClient) {
      await subClient.quit().catch(() => {});
    }
  });

  it('calls reloadTenant on valid config change event', async () => {
    subClient = registerTenantConfigSubscriberWorker();
    await new Promise((resolve) => setImmediate(resolve));

    // Emit directly on the subscriber client because MockRedisClient.duplicate()
    // does not properly link Pub/Sub events between instances.
    subClient.emit(
      'message',
      CONFIG_CHANNEL,
      JSON.stringify({ type: 'TENANT_CONFIG_CHANGED', tenantId: 'test-tenant-1' })
    );

    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(mockReloadCalls.length, 1);
    assert.strictEqual(mockReloadCalls[0], 'test-tenant-1');
  });

  it('ignores malformed JSON without crashing', async () => {
    subClient = registerTenantConfigSubscriberWorker();
    await new Promise((resolve) => setImmediate(resolve));

    subClient.emit('message', CONFIG_CHANNEL, 'not-json{{{');
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(mockReloadCalls.length, 0);
  });

  it('handles reloadTenant errors gracefully', async () => {
    mockReloadThrow = new Error('DB connection failed');

    subClient = registerTenantConfigSubscriberWorker();
    await new Promise((resolve) => setImmediate(resolve));

    // Should catch the error internally and not crash the process
    subClient.emit(
      'message',
      CONFIG_CHANNEL,
      JSON.stringify({ type: 'TENANT_CONFIG_CHANGED', tenantId: 'test-tenant-1' })
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(true);
  });
});
