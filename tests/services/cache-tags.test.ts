import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { resetEnvConfig } from '../../src/config/env.js';
import { Cache } from '../../src/constants.js';
import { registerVodTags } from '../../src/services/cache-tags.js';
import { markConnectionFailed, markConnectionRestored } from '../../src/utils/cache-state.js';
import { defaultCircuitBreaker } from '../../src/utils/circuit-breaker.js';
import { RedisService } from '../../src/utils/redis-service.js';

describe('CacheTags: registerVodTags', () => {
  let mockClient: any;
  let pipelineCalls: any[] = [];
  let pipelineItems: any[] = [];

  beforeEach(() => {
    pipelineCalls = [];
    pipelineItems = [];
    defaultCircuitBreaker.clearAllCircuits();
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
    await registerVodTags('tenant-1', [{ id: 1 }], 'testkey', 'data', 300, 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should register tags for page within limit', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 'data', 300, 1);
    assert.ok(pipelineCalls.length > 0);
    const hasSet = pipelineItems.some((i) => i.cmd === 'set');
    const hasSadd = pipelineItems.some((i) => i.cmd === 'sadd');
    assert.ok(hasSet, 'should set cache key');
    assert.ok(hasSadd, 'should add tag');
  });

  it('should skip registration when page exceeds MAX_PAGES', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 'data', 300, Cache.MAX_PAGES + 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should register tags when page equals MAX_PAGES', async () => {
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 'data', 300, Cache.MAX_PAGES);
    assert.ok(pipelineCalls.length > 0);
  });

  it('should skip registration when Redis connection is failed', async () => {
    markConnectionFailed('tenant-1');
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 'data', 300, 1);
    assert.strictEqual(pipelineCalls.length, 0);
  });

  it('should restore connection state on successful registration after failure', async () => {
    markConnectionFailed('tenant-1');
    markConnectionRestored('tenant-1');
    await registerVodTags('tenant-1', [{ id: 42 }], 'testkey', 'data', 300, 1);
    assert.ok(pipelineCalls.length > 0);
  });

  it('should handle empty vods list without creating tags', async () => {
    await registerVodTags('tenant-1', [], 'testkey', 'data', 300, 1);
    const hasSadd = pipelineItems.some((i) => i.cmd === 'sadd');
    assert.strictEqual(hasSadd, false, 'should not add tags for empty list');
  });

  it('should register tags for multiple vods', async () => {
    await registerVodTags('tenant-1', [{ id: 1 }, { id: 2 }, { id: 3 }], 'testkey', 'data', 300, 1);
    const saddCalls = pipelineItems.filter((i) => i.cmd === 'sadd');
    assert.strictEqual(saddCalls.length, 3);
  });
});
