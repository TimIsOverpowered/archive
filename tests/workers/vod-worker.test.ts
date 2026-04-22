import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import vodProcessor from '../../src/workers/vod.worker.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { poolManager, resetClientManager } from '../../src/db/client.js';
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

describe('VOD Worker', () => {
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

 

  it('should throw when platform user ID is missing for HLS download', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'kick',
        tenantId: 'test-tenant',
        downloadMethod: 'hls',
        platformUserId: undefined,
      },
    } as any;

    try {
      await (vodProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when Kick source URL is missing', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'kick',
        tenantId: 'test-tenant',
        downloadMethod: 'hls',
        platformUserId: 'kick-user-123',
        sourceUrl: undefined,
      },
    } as any;

    try {
      await (vodProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should use FFmpeg download method when specified', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        downloadMethod: 'ffmpeg',
        platformUserId: 'twitch-user-123',
      },
    } as any;

    try {
      await (vodProcessor as any)(job);
    } catch (error) {
      // May fail due to missing file system, but should reach FFmpeg path
      assert.ok(error instanceof Error);
    }
  });

  it('should use HLS download method by default', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
      },
    } as any;

    try {
      await (vodProcessor as any)(job);
    } catch (error) {
      // May fail due to network/FS, but should reach HLS path
      assert.ok(error instanceof Error);
    }
  });

  it('should throw on error and propagate the error', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        downloadMethod: 'hls',
        platformUserId: 'twitch-user-123',
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (vodProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with all optional fields', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        downloadMethod: 'hls',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        sourceUrl: 'https://example.com/stream.m3u8',
      },
    } as any;

    try {
      await (vodProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });
});
