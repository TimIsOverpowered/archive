import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { Cache } from '../../src/constants.js';
import { registerVodTags, invalidateTenantListCache } from '../../src/services/cache-tags.js';
import { markConnectionFailed, markConnectionRestored, cacheStateBreaker } from '../../src/utils/cache-state.js';
import { RedisService } from '../../src/utils/redis-service.js';

describe('CacheTags: registerVodTags', () => {
  let mockClient: any;
  let pipelineCalls: any[] = [];
  let pipelineItems: any[] = [];

  beforeEach(() => {
    pipelineCalls = [];
    pipelineItems = [];
    cacheStateBreaker.clearAllCircuits();
    mockClient = {
      pipeline: () => {
        const pipe = {
          set: (...args: any[]) => {
            pipelineItems.push({ cmd: 'set', args });
            return pipe;
          },
          sadd: (...args: any[]) => {
            pipelineItems.push({ cmd: 'sadd', args });
            return pipe;
          },
          pexpire: (...args: any[]) => {
            pipelineItems.push({ cmd: 'pexpire', args });
            return pipe;
          },
          exec: async () => pipelineItems.map(() => [null, 'OK']),
        };
        pipelineCalls.push(pipe);
        return pipe;
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

  it('should not register tags when Redis client is not available', async () => {
    (RedisService as any)._instance = null;
    await registerVodTags('tenant-1', [{ id: 1 }], 'testkey', 300, 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should register tags for page within limit', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 300, 1);
    assert.ok(pipelineCalls.length > 0);
    const hasSadd = pipelineItems.some((i) => i.cmd === 'sadd');
    assert.ok(hasSadd, 'should add tag');
  });

  it('should skip registration when page exceeds MAX_PAGES', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 300, Cache.MAX_PAGES + 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should register tags when page equals MAX_PAGES', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 300, Cache.MAX_PAGES);
    assert.ok(pipelineCalls.length > 0);
  });

  it('should skip registration when Redis connection is failed', async () => {
    markConnectionFailed('tenant-1');
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 300, 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should restore connection state on successful registration after failure', async () => {
    markConnectionFailed('tenant-1');
    markConnectionRestored('tenant-1');
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 300, 1);
    assert.ok(pipelineCalls.length > 0);
  });

  it('should handle empty vods list without creating tags', async () => {
    await registerVodTags('tenant-1', [], 'testkey', 300, 1);
    const hasSadd = pipelineItems.some((i) => i.cmd === 'sadd');
    assert.strictEqual(hasSadd, false, 'should not add tags for empty list');
  });

  it('should register tags for multiple vods', async () => {
    await registerVodTags('tenant-1', [{ id: 1 }, { id: 2 }, { id: 3 }], 'testkey', 300, 1);
    const saddCalls = pipelineItems.filter((i) => i.cmd === 'sadd');
    assert.strictEqual(saddCalls.length, 3);
  });
});

describe('CacheTags: invalidateTenantListCache', () => {
  let mockClient: any;
  let scanArgs: any[][] = [];
  let unlinkCalls: any[][] = [];

  beforeEach(() => {
    scanArgs = [];
    unlinkCalls = [];
    mockClient = {
      scan: async (cursor: string, ...rest: any[]) => {
        scanArgs.push([cursor, ...rest]);
        if (cursor === '0') {
          return ['1', ['simple:tenants:{{}}:page:1:limit:20', 'simple:tenants:detail:{t1}']];
        }
        return ['0', []];
      },
      unlink: async (...keys: any[]) => {
        unlinkCalls.push(keys);
        return keys.length;
      },
    };
    (RedisService as any)._instance = { client: mockClient };
    resetEnvConfig();
  });

  afterEach(() => {
    (RedisService as any)._instance = null;
    resetEnvConfig();
  });

  it('scans the simple:tenants:* pattern and unlinks every key', async () => {
    await invalidateTenantListCache();

    assert.ok(scanArgs.length >= 1, 'should run at least one SCAN');
    assert.ok(scanArgs[0]!.includes('MATCH'), 'SCAN must use MATCH');
    assert.ok(scanArgs[0]!.includes('simple:tenants:*'), 'SCAN must target the simple:tenants:* keys');
    assert.deepStrictEqual(unlinkCalls, [['simple:tenants:{{}}:page:1:limit:20', 'simple:tenants:detail:{t1}']]);
  });

  it('does nothing when no Redis client is available', async () => {
    (RedisService as any)._instance = null;
    await invalidateTenantListCache();
    assert.strictEqual(scanArgs.length, 0);
    assert.strictEqual(unlinkCalls.length, 0);
  });

  it('loops the SCAN cursor until it returns to 0', async () => {
    mockClient.scan = async (cursor: string) => {
      if (cursor === '0') return ['1', ['keyA']];
      if (cursor === '1') return ['2', ['keyB']];
      return ['0', []];
    };
    await invalidateTenantListCache();
    assert.deepStrictEqual(unlinkCalls, [['keyA'], ['keyB']]);
  });

  it('does not unlink when a SCAN batch returns no keys', async () => {
    mockClient.scan = async () => ['0', []];
    await invalidateTenantListCache();
    assert.strictEqual(unlinkCalls.length, 0);
  });
});
