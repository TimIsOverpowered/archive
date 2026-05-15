import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { publishVodUpdate, publishVodDurationUpdate, publishGameUpdate } from '../../src/services/cache-invalidator.js';
import { RedisService } from '../../src/utils/redis-service.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

setupBaseEnv();

describe('CacheInvalidator: publishVodUpdate', () => {
  let mockClient: any;
  let publishCalls: { channel: string; message: string }[] = [];

  beforeEach(() => {
    publishCalls = [];
    mockClient = {
      publish: async (channel: string, message: string) => {
        publishCalls.push({ channel, message });
      },
    };
    (RedisService as any)._instance = {
      client: mockClient,
    };
    resetEnvConfig();
  });

  afterEach(() => {
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should not publish when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    await publishVodUpdate('tenant-1', 42);
    assert.strictEqual(publishCalls.length, 0);
  });

  it('should publish VOD_UPDATED event', async () => {
    await publishVodUpdate('tenant-1', 42);
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0]?.channel, 'cache:vod');
    const event = JSON.parse(publishCalls[0]?.message);
    assert.strictEqual(event.type, 'VOD_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-1');
    assert.strictEqual(event.dbId, 42);
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.publish = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(publishVodUpdate('tenant-1', 42));
  });

  it('should use correct Redis channel', async () => {
    await publishVodUpdate('tenant-1', 42);
    assert.strictEqual(publishCalls[0]?.channel, 'cache:vod');
  });

  it('should publish correct event structure', async () => {
    await publishVodUpdate('tenant-2', 999);
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.ok('type' in event);
    assert.ok('tenantId' in event);
    assert.ok('dbId' in event);
    assert.strictEqual(event.type, 'VOD_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-2');
    assert.strictEqual(event.dbId, 999);
  });
});

describe('CacheInvalidator: publishVodDurationUpdate', () => {
  let mockClient: any;
  let publishCalls: { channel: string; message: string }[] = [];

  beforeEach(() => {
    publishCalls = [];
    mockClient = {
      publish: async (channel: string, message: string) => {
        publishCalls.push({ channel, message });
      },
    };
    (RedisService as any)._instance = {
      client: mockClient,
    };
    resetEnvConfig();
  });

  afterEach(() => {
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should not publish when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    await publishVodDurationUpdate('tenant-1', 42, 3600, false);
    assert.strictEqual(publishCalls.length, 0);
  });

  it('should publish VOD_DURATION_UPDATED event with duration', async () => {
    await publishVodDurationUpdate('tenant-1', 42, 3600, false);
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0]?.channel, 'cache:vod');
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.strictEqual(event.type, 'VOD_DURATION_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-1');
    assert.strictEqual(event.dbId, 42);
    assert.strictEqual(event.duration, 3600);
    assert.strictEqual(event.is_live, false);
  });

  it('should publish with is_live: true', async () => {
    await publishVodDurationUpdate('tenant-1', 42, 7200, true);
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.strictEqual(event.type, 'VOD_DURATION_UPDATED');
    assert.strictEqual(event.duration, 7200);
    assert.strictEqual(event.is_live, true);
  });

  it('should handle zero duration', async () => {
    await publishVodDurationUpdate('tenant-1', 42, 0, false);
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.strictEqual(event.duration, 0);
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.publish = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(publishVodDurationUpdate('tenant-1', 42, 3600, false));
  });

  it('should use correct Redis channel', async () => {
    await publishVodDurationUpdate('tenant-1', 42, 3600, false);
    assert.strictEqual(publishCalls[0]?.channel, 'cache:vod');
  });

  it('should publish correct event structure', async () => {
    await publishVodDurationUpdate('tenant-3', 100, 1800, true);
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.ok('type' in event);
    assert.ok('tenantId' in event);
    assert.ok('dbId' in event);
    assert.ok('duration' in event);
    assert.ok('is_live' in event);
  });
});

describe('CacheInvalidator: publishGameUpdate', () => {
  let mockClient: any;
  let publishCalls: { channel: string; message: string }[] = [];

  beforeEach(() => {
    publishCalls = [];
    mockClient = {
      publish: async (channel: string, message: string) => {
        publishCalls.push({ channel, message });
      },
    };
    (RedisService as any)._instance = {
      client: mockClient,
    };
    resetEnvConfig();
  });

  afterEach(() => {
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should not publish when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    await publishGameUpdate('tenant-1');
    assert.strictEqual(publishCalls.length, 0);
  });

  it('should publish GAME_UPDATED event', async () => {
    await publishGameUpdate('tenant-1');
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0]?.channel, 'cache:game');
    const event = JSON.parse(publishCalls[0]?.message);
    assert.strictEqual(event.type, 'GAME_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-1');
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.publish = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(publishGameUpdate('tenant-1'));
  });

  it('should use correct Redis channel', async () => {
    await publishGameUpdate('tenant-1');
    assert.strictEqual(publishCalls[0]?.channel, 'cache:game');
  });

  it('should publish correct event structure', async () => {
    await publishGameUpdate('tenant-2');
    const event = JSON.parse(publishCalls[0]?.message ?? '');
    assert.ok('type' in event);
    assert.ok('tenantId' in event);
    assert.strictEqual(event.type, 'GAME_UPDATED');
    assert.strictEqual(event.tenantId, 'tenant-2');
  });
});
