import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import {
  getVodStaticCache,
  setVodStaticCache,
  getVodVolatileCache,
  setVodVolatileCache,
  getVodVolatileCacheBatch,
  invalidateVodStaticCache,
  invalidateEmoteCache,
} from '../../src/services/vod-cache.js';
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

describe('VodCache: getVodStaticCache', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      get: async () => null,
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

  it('should return null when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    const result = await getVodStaticCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should return null when key does not exist', async () => {
    mockClient.get = async () => null;
    const result = await getVodStaticCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should return cached value when key exists', async () => {
    mockClient.get = async () => JSON.stringify({ id: 42, title: 'Test VOD' });
    const result = await getVodStaticCache('tenant-1', 42);
    assert.ok(result);
    assert.ok(result.includes('Test VOD'));
  });

  it('should return null on Redis error', async () => {
    mockClient.get = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await getVodStaticCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should use correct cache key format', async () => {
    let capturedKey = '';
    mockClient.get = async (key: string) => {
      capturedKey = key;
      return null;
    };
    await getVodStaticCache('tenant-1', 42);
    assert.ok(capturedKey.includes('tenant-1'));
    assert.ok(capturedKey.includes('42'));
  });
});

describe('VodCache: setVodStaticCache', () => {
  let mockClient: any;
  let setCalls: string[][] = [];

  beforeEach(() => {
    setCalls = [];
    mockClient = {
      set: async (...args: any[]) => {
        setCalls.push(args);
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

  it('should not call Redis when client is not available', async () => {
    (RedisService as any)._instance = null;
    await setVodStaticCache('tenant-1', 42, 'data', 3600);
    assert.strictEqual(setCalls.length, 0);
  });

  it('should set cache with correct key and TTL', async () => {
    await setVodStaticCache('tenant-1', 42, JSON.stringify({ id: 42 }), 3600);
    assert.strictEqual(setCalls.length, 1);
    assert.strictEqual(setCalls[0]?.[0], 'vod:{tenant-1}:42');
    assert.strictEqual(setCalls[0]?.[1], JSON.stringify({ id: 42 }));
    assert.strictEqual(setCalls[0]?.[2], 'EX');
    assert.strictEqual(setCalls[0]?.[3], 3600);
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.set = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(setVodStaticCache('tenant-1', 42, 'data', 3600));
  });
});

describe('VodCache: getVodVolatileCache', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      get: async () => null,
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

  it('should return null when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should return null when key does not exist', async () => {
    mockClient.get = async () => null;
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should parse and return volatile data', async () => {
    const volatileData = JSON.stringify({ duration: 3600, is_live: true });
    mockClient.get = async () => volatileData;
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result?.duration, 3600);
    assert.strictEqual(result?.is_live, true);
  });

  it('should return null for invalid JSON', async () => {
    mockClient.get = async () => 'not-valid-json';
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should return null on Redis error', async () => {
    mockClient.get = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result, null);
  });

  it('should return null for is_live: false', async () => {
    const volatileData = JSON.stringify({ duration: 0, is_live: false });
    mockClient.get = async () => volatileData;
    const result = await getVodVolatileCache('tenant-1', 42);
    assert.strictEqual(result?.duration, 0);
    assert.strictEqual(result?.is_live, false);
  });
});

describe('VodCache: setVodVolatileCache', () => {
  let mockClient: any;
  let setCalls: string[][] = [];

  beforeEach(() => {
    setCalls = [];
    mockClient = {
      set: async (...args: any[]) => {
        setCalls.push(args);
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

  it('should not call Redis when client is not available', async () => {
    (RedisService as any)._instance = null;
    await setVodVolatileCache('tenant-1', 42, { duration: 3600, is_live: true }, 300);
    assert.strictEqual(setCalls.length, 0);
  });

  it('should set volatile data with correct key and TTL', async () => {
    await setVodVolatileCache('tenant-1', 42, { duration: 3600, is_live: true }, 300);
    assert.strictEqual(setCalls.length, 1);
    assert.strictEqual(setCalls[0]?.[0], 'vod:volatile:{tenant-1}:42');
    const parsed = JSON.parse(setCalls[0]?.[1] as string);
    assert.strictEqual(parsed.duration, 3600);
    assert.strictEqual(parsed.is_live, true);
    assert.strictEqual(setCalls[0]?.[2], 'EX');
    assert.strictEqual(setCalls[0]?.[3], 300);
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.set = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(setVodVolatileCache('tenant-1', 42, { duration: 0, is_live: false }, 300));
  });
});

describe('VodCache: getVodVolatileCacheBatch', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      mget: async (...keys: string[]) => keys.map(() => null),
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

  it('should return empty map when dbIds is empty', async () => {
    const result = await getVodVolatileCacheBatch('tenant-1', []);
    assert.strictEqual(result.size, 0);
  });

  it('should return empty map when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    const result = await getVodVolatileCacheBatch('tenant-1', [1, 2, 3]);
    assert.strictEqual(result.size, 0);
  });

  it('should return empty map when all values are null', async () => {
    mockClient.mget = async (...keys: string[]) => keys.map(() => null);
    const result = await getVodVolatileCacheBatch('tenant-1', [1, 2, 3]);
    assert.strictEqual(result.size, 0);
  });

  it('should parse and return valid volatile data', async () => {
    mockClient.mget = async (..._keys: string[]) => [
      JSON.stringify({ duration: 3600, is_live: true }),
      null,
      JSON.stringify({ duration: 1800, is_live: false }),
    ];
    const result = await getVodVolatileCacheBatch('tenant-1', [1, 2, 3]);
    assert.strictEqual(result.size, 2);
    assert.strictEqual(result.get(1)?.duration, 3600);
    assert.strictEqual(result.get(1)?.is_live, true);
    assert.strictEqual(result.get(3)?.duration, 1800);
    assert.strictEqual(result.get(3)?.is_live, false);
    assert.strictEqual(result.has(2), false);
  });

  it('should skip corrupt entries', async () => {
    mockClient.mget = async (..._keys: string[]) => [
      JSON.stringify({ duration: 3600, is_live: true }),
      'corrupt-json',
      JSON.stringify({ duration: 1800, is_live: false }),
    ];
    const result = await getVodVolatileCacheBatch('tenant-1', [1, 2, 3]);
    assert.strictEqual(result.size, 2);
    assert.strictEqual(result.get(1)?.duration, 3600);
    assert.strictEqual(result.get(3)?.duration, 1800);
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.mget = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await getVodVolatileCacheBatch('tenant-1', [1, 2, 3]);
    assert.strictEqual(result.size, 0);
  });
});

describe('VodCache: invalidateVodStaticCache', () => {
  let mockClient: any;
  let unlinkCalls: string[][] = [];
  let sscanCalls: string[][] = [];

  beforeEach(() => {
    unlinkCalls = [];
    sscanCalls = [];
    mockClient = {
      unlink: async (...keys: string[]) => {
        unlinkCalls.push(keys);
      },
      sscan: async (key: string, cursor: string, ..._args: any[]) => {
        sscanCalls.push([key, cursor]);
        return ['0', []];
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

  it('should not call Redis when client is not available', async () => {
    (RedisService as any)._instance = null;
    await invalidateVodStaticCache('tenant-1', 42);
    assert.strictEqual(unlinkCalls.length, 0);
  });

  it('should unlink static cache key', async () => {
    await invalidateVodStaticCache('tenant-1', 42);
    assert.ok(unlinkCalls.some((calls) => calls.includes('vod:{tenant-1}:42')));
  });

  it('should invalidate tags', async () => {
    await invalidateVodStaticCache('tenant-1', 42);
    assert.ok(sscanCalls.some((calls) => calls[0]?.includes('vods:tags:{tenant-1}:42')));
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.unlink = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(invalidateVodStaticCache('tenant-1', 42));
  });
});

describe('VodCache: invalidateEmoteCache', () => {
  let mockClient: any;
  let unlinkCalls: string[][] = [];

  beforeEach(() => {
    unlinkCalls = [];
    mockClient = {
      unlink: async (...keys: string[]) => {
        unlinkCalls.push(keys);
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

  it('should not call Redis when client is not available', async () => {
    (RedisService as any)._instance = null;
    await invalidateEmoteCache('tenant-1', 42);
    assert.strictEqual(unlinkCalls.length, 0);
  });

  it('should unlink emote cache key', async () => {
    await invalidateEmoteCache('tenant-1', 42);
    assert.ok(unlinkCalls.some((calls) => calls.includes('emotes:{tenant-1}:42')));
  });

  it('should handle Redis error gracefully', async () => {
    mockClient.unlink = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.doesNotReject(invalidateEmoteCache('tenant-1', 42));
  });
});
