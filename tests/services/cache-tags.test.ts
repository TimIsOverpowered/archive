import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { registerVodTags, invalidateVodTags, invalidateVodVolatileCache } from '../../src/services/cache-tags.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { resetEnvConfig } from '../../src/config/env.js';

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

describe('registerVodTags', () => {
  let mockClient: any;
  let redisCalls: string[] = [];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    redisCalls = [];
    mockClient = {
      set: async (...args: any[]) => {
        redisCalls.push(`set:${args.join(',')}`);
      },
      sadd: async (...args: any[]) => {
        redisCalls.push(`sadd:${args.join(',')}`);
      },
      pexpire: async (...args: any[]) => {
        redisCalls.push(`pexpire:${args.join(',')}`);
      },
      get: async () => null,
      pipeline: () => ({
        set: (...args: any[]) => {
          redisCalls.push(`set:${args.join(',')}`);
          return {
            sadd: (...args: any[]) => {
              redisCalls.push(`sadd:${args.join(',')}`);
              return {
                pexpire: (...args: any[]) => {
                  redisCalls.push(`pexpire:${args.join(',')}`);
                  return { exec: async () => [] };
                },
              };
            },
          };
        },
        sadd: (...args: any[]) => {
          redisCalls.push(`sadd:${args.join(',')}`);
          return {
            pexpire: (...args: any[]) => {
              redisCalls.push(`pexpire:${args.join(',')}`);
              return { exec: async () => [] };
            },
          };
        },
        pexpire: (...args: any[]) => {
          redisCalls.push(`pexpire:${args.join(',')}`);
          return { exec: async () => [] };
        },
        exec: async () => [],
      }),
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should register cache key and tags for each vod', async () => {
    await registerVodTags('tenant-1', [{ id: 1 }, { id: 2 }], 'vod:cache:123:page:0', 'cached-data', 3600);

    assert.ok(redisCalls.some((c) => c.startsWith('set:vod:cache:123:page:0')));
    assert.ok(redisCalls.some((c) => c.includes('vods:tags:{tenant-1}:1')));
    assert.ok(redisCalls.some((c) => c.includes('vods:tags:{tenant-1}:2')));
  });

  it('should skip pages exceeding MAX_CACHE_PAGES', async () => {
    await registerVodTags('tenant-1', [{ id: 1 }], 'vod:cache:123:page:11', 'data', 3600);

    assert.strictEqual(redisCalls.length, 0);
  });

  it('should allow page 10 (at MAX_CACHE_PAGES boundary)', async () => {
    await registerVodTags('tenant-1', [{ id: 1 }], 'vod:cache:123:page:10', 'data', 3600);

    assert.ok(redisCalls.some((c) => c.startsWith('set:vod:cache:123:page:10')));
  });

  it('should handle single vod', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'vod:cache:42', 'data', 3600);

    assert.ok(redisCalls.some((c) => c.includes('vods:tags:{tenant-1}:42')));
  });

  it('should handle empty vods array', async () => {
    await registerVodTags('tenant-1', [], 'vod:cache:123', 'data', 3600);

    assert.ok(redisCalls.some((c) => c.startsWith('set:vod:cache:123')));
    assert.strictEqual(redisCalls.filter((c) => c.startsWith('sadd:')).length, 0);
  });

  it('should handle Redis connection error', async () => {
    mockClient.set = async () => {
      const err = new Error('ECONNREFUSED');
      throw err;
    };

    await assert.doesNotReject(registerVodTags('tenant-1', [{ id: 1 }], 'cache:key', 'data', 3600));
  });
});

describe('invalidateVodTags', () => {
  let mockClient: any;
  let redisCalls: string[] = [];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    redisCalls = [];
    mockClient = {
      sscan: async (key: string, cursor: string, ...args: any[]) => {
        redisCalls.push(`sscan:${key}:${cursor}`);
        if (cursor === '0') {
          return ['1', ['key1', 'key2']];
        }
        return ['0', []];
      },
      unlink: async (...keys: string[]) => {
        redisCalls.push(`unlink:${keys.join(',')}`);
      },
      del: async (...keys: string[]) => {
        redisCalls.push(`del:${keys.join(',')}`);
      },
      get: async () => null,
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should scan and invalidate all tagged keys', async () => {
    await invalidateVodTags('tenant-1', 42);

    assert.ok(redisCalls.some((c) => c.includes('vods:tags:{tenant-1}:42')));
    assert.ok(redisCalls.some((c) => c.startsWith('unlink:')));
    assert.ok(redisCalls.some((c) => c.includes('key1')));
    assert.ok(redisCalls.some((c) => c.includes('key2')));
    assert.ok(redisCalls.some((c) => c.includes('del:vods:tags:{tenant-1}:42')));
  });

  it('should handle empty tag set', async () => {
    mockClient.sscan = async (_key: string, cursor: string) => {
      redisCalls.push(`sscan:${cursor}`);
      return ['0', []];
    };

    await invalidateVodTags('tenant-1', 42);

    assert.ok(redisCalls.some((c) => c.includes('del:vods:tags:{tenant-1}:42')));
    assert.strictEqual(redisCalls.filter((c) => c.startsWith('unlink:')).length, 0);
  });
});

describe('invalidateVodVolatileCache', () => {
  let mockClient: any;
  let redisCalls: string[] = [];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    redisCalls = [];
    mockClient = {
      unlink: async (...keys: string[]) => {
        redisCalls.push(`unlink:${keys.join(',')}`);
      },
      get: async () => null,
    };

    (RedisService as any)._instance = {
      client: mockClient,
    };

    resetEnvConfig();
  });

  afterEach(async () => {
    Object.assign(process.env, originalEnv);
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('should unlink volatile cache key', async () => {
    await invalidateVodVolatileCache('tenant-1', 42);

    assert.ok(redisCalls.some((c) => c.includes('vod:volatile:{tenant-1}:42')));
  });

  it('should handle Redis connection error', async () => {
    mockClient.unlink = async () => {
      const err = new Error('ECONNREFUSED');
      throw err;
    };

    await assert.doesNotReject(invalidateVodVolatileCache('tenant-1', 42));
  });
});
