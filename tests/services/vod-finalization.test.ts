import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { finalizeVod } from '../../src/services/vod-finalization.js';
import { registerStrategy } from '../../src/services/platforms/strategy.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { poolManager, resetClientManager } from '../../src/db/streamer-client.js';
import { resetEnvConfig } from '../../src/config/env.js';
import { createMockTenantConfig } from '../helpers/worker-test-setup.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
}

setupBaseEnv();

describe('finalizeVod', () => {
  let mockDb: any;
  let mockStrategy: any;
  let publishCalled = false;
  let publishArgs: any = null;
  let mockClient: any;
  let updateSet: any = null;
  let operationCalls: any[] = [];

  function createMockDb(): any {
    return {
      updateTable: () => ({
        set: (s: any) => {
          updateSet = s;
          return {
            where: () => ({
              execute: async () => undefined,
            }),
          };
        },
      }),
      transaction: () => ({
        execute: async (fn: any) => {
          const trx = {
            updateTable: () => ({
              set: (s: any) => {
                updateSet = s;
                return {
                  where: () => ({
                    execute: async () => undefined,
                  }),
                };
              },
            }),
          };
          await fn(trx);
        },
      }),
    };
  }

  beforeEach(async () => {
    publishCalled = false;
    publishArgs = null;
    updateSet = null;
    operationCalls = [];

    mockDb = createMockDb();

    mockStrategy = {
      finalizeChapters: async (ctx: any, dbId: number, vodId: string, duration: number) => {
        operationCalls.push({ type: 'finalizeChapters', ctx, dbId, vodId, duration });
      },
    };

    registerStrategy('twitch' as any, mockStrategy);

    mockClient = {
      publish: async (channel: string, message: string) => {
        publishCalled = true;
        publishArgs = { channel, message };
      },
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
    resetClientManager();
    mock.method(poolManager, 'createClient', async () => mockDb);
    mock.method(poolManager, 'closeClient', async () => {});
  });

  afterEach(async () => {
    (RedisService as any)._instance = null;
    mock.restoreAll();
    resetClientManager();
    resetEnvConfig();
  });

  it('should update VOD with is_live: false', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: 3600 });

    assert.ok(updateSet);
    assert.strictEqual(updateSet.is_live, false);
    assert.strictEqual(updateSet.duration, 3600);
  });

  it('should call strategy.finalizeChapters when duration is provided and strategy has finalizeChapters', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: 3600 });

    assert.strictEqual(operationCalls.length, 1);
    assert.strictEqual(operationCalls[0].dbId, 42);
    assert.strictEqual(operationCalls[0].vodId, 'vod-123');
    assert.strictEqual(operationCalls[0].duration, 3600);
  });

  it('should not call finalizeChapters when durationSeconds is null', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: null });

    assert.strictEqual(operationCalls.length, 0);
  });

it('should not call finalizeChapters when strategy does not have finalizeChapters', async () => {
    const mockStrategyNoChapters = {} as any;
    registerStrategy('twitch' as any, mockStrategyNoChapters);

    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: 3600 });

    assert.strictEqual(operationCalls.length, 0);
  });

  it('should not include duration in update when durationSeconds is null', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: null });

    assert.ok(updateSet);
    assert.strictEqual(updateSet.is_live, false);
    assert.strictEqual('duration' in updateSet, false);
  });

  it('should publish VOD duration update event', async () => {
    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: 3600 });

    assert.strictEqual(publishCalled, true);
    assert.ok(publishArgs);
    const event = JSON.parse(publishArgs.message);
    assert.strictEqual(event.type, 'VOD_DURATION_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-1');
    assert.strictEqual(event.dbId, 42);
    assert.strictEqual(event.duration, 3600);
    assert.strictEqual(event.is_live, false);
  });

  it('should publish event with duration 0 when durationSeconds is null', async () => {
    publishCalled = false;
    publishArgs = null;

    const ctx = {
      tenantId: 'tenant-1',
      config: createMockTenantConfig({ id: 'tenant-1', twitch: { enabled: true }, database: { url: 'postgresql://test' }, settings: { domainName: 'test.com', timezone: 'UTC', saveMP4: true, saveHLS: false } }),
      db: mockDb,
    };

    await finalizeVod({ ctx, dbId: 42, vodId: 'vod-123', platform: 'twitch', durationSeconds: null });

    assert.strictEqual(publishCalled, true);
    assert.ok(publishArgs);
    const event = JSON.parse(publishArgs.message);
    assert.strictEqual(event.duration, 0);
  });
});
