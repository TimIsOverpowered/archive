import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { Cache } from '../../src/constants.js';
import { publishVodUpdate, handleCacheEvent } from '../../src/services/cache-invalidator.js';
import { setVodVolatileCache } from '../../src/services/vod-cache.js';
import { CacheKeys, swrKeys } from '../../src/utils/cache-keys.js';
import { RedisService } from '../../src/utils/redis-service.js';
import { createRedisSubscriber } from '../../src/utils/redis-subscriber.js';

const CACHE_CHANNEL = 'cache:vod';

describe('Integration: VOD cache invalidation round-trip via Pub/Sub', () => {
  let redis: Redis;
  let destroySubscriber: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    redis = new RedisMock({ lazyConnect: true });
    await redis.connect();
    (RedisService as any)._instance = { client: redis };
  });

  afterEach(async () => {
    if (destroySubscriber) {
      await destroySubscriber();
      destroySubscriber = null;
    }
    (RedisService as any)._instance = null;
  });

  it('VOD_UPDATED event invalidates static cache, volatile cache, and tag keys', async () => {
    const tenantId = 'roundtrip-tenant';
    const dbId = 777;

    // Set up cache entries — tags key must be a set for sscan to work
    await redis.set(swrKeys.vodStatic(tenantId, dbId), '{"data":"swr"}');
    await redis.sadd(CacheKeys.vodTags(tenantId, dbId), 'some:cache:key');
    await setVodVolatileCache(tenantId, dbId, { duration: 120, is_live: false }, Cache.VOD_VOLATILE_TTL);

    assert.ok(await redis.get(swrKeys.vodStatic(tenantId, dbId)));
    assert.ok((await redis.scard(CacheKeys.vodTags(tenantId, dbId))) > 0);
    assert.ok(await redis.get(CacheKeys.vodVolatile(tenantId, dbId)));

    const { destroy } = createRedisSubscriber({
      channel: CACHE_CHANNEL,
      handler: handleCacheEvent,
      loggerModule: 'cache-subscriber',
    });
    destroySubscriber = destroy;

    // Wait for subscriber to connect and subscribe
    await new Promise((resolve) => setTimeout(resolve, 50));

    await publishVodUpdate(tenantId, dbId);

    // Wait for async handler to complete (fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(await redis.get(swrKeys.vodStatic(tenantId, dbId)), null);
    assert.strictEqual(await redis.get(CacheKeys.vodVolatile(tenantId, dbId)), null);
    assert.strictEqual(await redis.exists(CacheKeys.vodTags(tenantId, dbId)), 0);
  });

  it('VOD_DURATION_UPDATED event sets volatile cache with new duration', async () => {
    const tenantId = 'duration-tenant';
    const dbId = 888;

    let receivedEvent: unknown = null;
    const originalHandler = handleCacheEvent;
    const { destroy } = createRedisSubscriber({
      channel: CACHE_CHANNEL,
      handler: async (event: unknown) => {
        receivedEvent = event;
        await originalHandler(event as Parameters<typeof originalHandler>[0]);
      },
      loggerModule: 'cache-subscriber',
    });
    destroySubscriber = destroy;

    await new Promise((resolve) => setTimeout(resolve, 50));

    const pubClient = new RedisMock({ lazyConnect: true });
    await pubClient.connect();
    await pubClient.publish(
      CACHE_CHANNEL,
      JSON.stringify({ type: 'VOD_DURATION_UPDATED', tenantId, dbId, duration: 5400, is_live: true })
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    const evt = receivedEvent as { type: string; duration?: number } | null;
    assert.strictEqual(evt?.type, 'VOD_DURATION_UPDATED');
    assert.strictEqual(evt?.duration, 5400);

    const cached = await redis.get(CacheKeys.vodVolatile(tenantId, dbId));
    assert.ok(cached);
    const parsed = JSON.parse(cached);
    assert.strictEqual(parsed.duration, 5400);
    assert.strictEqual(parsed.is_live, true);

    await pubClient.quit();
  });

  it('multiple VOD_UPDATED events invalidate different VODs independently', async () => {
    const tenantId = 'multi-tenant';
    const dbId1 = 100;
    const dbId2 = 200;

    await redis.set(swrKeys.vodStatic(tenantId, dbId1), '{"data":"vod1"}');
    await redis.set(swrKeys.vodStatic(tenantId, dbId2), '{"data":"vod2"}');

    const { destroy } = createRedisSubscriber({
      channel: CACHE_CHANNEL,
      handler: handleCacheEvent,
      loggerModule: 'cache-subscriber',
    });
    destroySubscriber = destroy;

    await new Promise((resolve) => setTimeout(resolve, 50));

    await publishVodUpdate(tenantId, dbId1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(await redis.get(swrKeys.vodStatic(tenantId, dbId1)), null);
    assert.strictEqual(await redis.get(swrKeys.vodStatic(tenantId, dbId2)), '{"data":"vod2"}');

    await publishVodUpdate(tenantId, dbId2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(await redis.get(swrKeys.vodStatic(tenantId, dbId2)), null);
  });
});
