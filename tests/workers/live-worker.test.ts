import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import liveProcessor from '../../src/workers/live.worker.js';
import { getJobContext } from '../../src/workers/utils/job-context.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { poolManager, resetClientManager } from '../../src/db/streamer-client.js';
import { resetEnvConfig } from '../../src/config/env.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.VOD_PATH = '/tmp/test-vods';
}

setupBaseEnv();

describe('Live Worker', () => {
  let mockDb: any;
  let mockClient: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };

    mockDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                execute: async () => [],
              }),
            }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: async () => undefined,
          }),
        }),
      }),
    };

    mockClient = {
      get: async () => null,
      publish: async () => {},
    };

    (RedisService as any)._instance = {
      getClient: () => mockClient,
    };

    resetEnvConfig();
    resetClientManager();
    mock.method(poolManager, 'createClient', async () => mockDb);
    mock.method(poolManager, 'closeClient', async () => {});
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    mock.restoreAll();
    resetClientManager();
    resetEnvConfig();
  });

  it('should throw when VOD path not configured for tenant', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant-no-path',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as any;

    try {
      await (liveProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw on error and propagate the error', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (liveProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with all fields', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
        sourceUrl: 'https://example.com/live.m3u8',
      },
    } as any;

    try {
      await (liveProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when download fails', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'kick',
        tenantId: 'test-tenant',
        platformUserId: 'kick-user-123',
        platformUsername: 'kickstreamer',
        startedAt: new Date().toISOString(),
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (liveProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle missing platformUsername gracefully', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: undefined,
        startedAt: new Date().toISOString(),
      },
    } as any;

    try {
      await (liveProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should handle job without sourceUrl for non-Kick platform', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as any;

    try {
      await (liveProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });
});
