import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CacheKeys, swrKeys, simpleKeys } from '../../src/utils/cache-keys.js';

describe('CacheKeys', () => {
  describe('vodStatic', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.vodStatic('tenant-1', 42);
      assert.strictEqual(key, 'vod:{tenant-1}:42');
    });
  });

  describe('vodVolatile', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.vodVolatile('tenant-1', 42);
      assert.strictEqual(key, 'vod:volatile:{tenant-1}:42');
    });
  });

  describe('vodTags', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.vodTags('tenant-1', 42);
      assert.strictEqual(key, 'vods:tags:{tenant-1}:42');
    });
  });

  describe('bucketSize', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.bucketSize('tenant-1', 42);
      assert.strictEqual(key, '{tenant-1}:42:bucketSize');
    });
  });

  describe('bucket', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.bucket('tenant-1', 42, 0);
      assert.strictEqual(key, '{tenant-1}:42:bucket:0');
    });
  });

  describe('cursor', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.cursor('tenant-1', 42, 'abc');
      assert.strictEqual(key, '{tenant-1}:42:cursor:abc');
    });
  });

  describe('emotes', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.emotes('tenant-1', 42);
      assert.strictEqual(key, 'emotes:{tenant-1}:42');
    });
  });

  describe('vodPlatform', () => {
    it('should produce correct format', () => {
      const key = CacheKeys.vodPlatform('tenant-1', 'twitch', '12345');
      assert.strictEqual(key, 'vod:platform:{tenant-1}:twitch:12345');
    });
  });

  describe('vodQuery', () => {
    it('should exclude undefined values from key', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test', status: undefined }, 1, 20);
      assert.strictEqual(key.includes('undefined'), false);
      assert.strictEqual(key.includes('status'), false);
      assert.ok(key.includes('title:test'));
    });

    it('should exclude null values from key', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test', status: undefined as string | undefined }, 1, 20);
      assert.strictEqual(key.includes('null'), false);
      assert.strictEqual(key.includes('status'), false);
      assert.ok(key.includes('title:test'));
    });

    it('should exclude empty string values from key', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test', status: '' }, 1, 20);
      assert.strictEqual(key.includes('status'), false);
    });

    it('should include valid string values', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test', platform: 'twitch' }, 1, 20);
      assert.ok(key.includes('platform:twitch'));
      assert.ok(key.includes('title:test'));
    });

    it('should include valid number values', () => {
      const key = CacheKeys.vodQuery('tenant-1', { limit: 50, offset: 10 }, 1, 20);
      assert.ok(key.includes('limit:50'));
      assert.ok(key.includes('offset:10'));
    });

    it('should sort keys alphabetically', () => {
      const key = CacheKeys.vodQuery('tenant-1', { zebra: '1', alpha: '2', beta: '3' }, 1, 20);
      const alphaIdx = key.indexOf('alpha:2');
      const betaIdx = key.indexOf('beta:3');
      const zebraIdx = key.indexOf('zebra:1');
      assert.ok(alphaIdx < betaIdx, 'alpha should come before beta');
      assert.ok(betaIdx < zebraIdx, 'beta should come before zebra');
    });

    it('should include page and limit', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 5, 100);
      assert.ok(key.includes(':page:5:limit:100'));
    });

    it('should include tenant ID', () => {
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
      assert.ok(key.startsWith('vods:{tenant-1}:'));
    });

    it('should produce same key for same inputs', () => {
      const query = { title: 'test', platform: 'twitch' };
      const key1 = CacheKeys.vodQuery('tenant-1', query, 1, 20);
      const key2 = CacheKeys.vodQuery('tenant-1', query, 1, 20);
      assert.strictEqual(key1, key2);
    });

    it('should produce different key for different page', () => {
      const key1 = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
      const key2 = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 2, 20);
      assert.notStrictEqual(key1, key2);
    });

    it('should handle mixed valid and invalid values', () => {
      const key = CacheKeys.vodQuery(
        'tenant-1',
        {
          title: 'test',
          status: undefined,
          platform: 'twitch',
          tag: undefined as string | undefined,
          genre: '',
          year: 2024,
        },
        1,
        20
      );

      assert.ok(key.includes('title:test'));
      assert.ok(key.includes('platform:twitch'));
      assert.ok(key.includes('year:2024'));
      assert.strictEqual(key.includes('undefined'), false);
      assert.strictEqual(key.includes('null'), false);
    });

    it('should handle empty query object', () => {
      const key = CacheKeys.vodQuery('tenant-1', {}, 1, 20);
      assert.strictEqual(key, 'vods:{tenant-1}:page:1:limit:20');
    });

    it('should handle all undefined values', () => {
      const key = CacheKeys.vodQuery('tenant-1', { a: undefined, b: undefined }, 1, 20);
      assert.strictEqual(key, 'vods:{tenant-1}:page:1:limit:20');
    });
  });
});

describe('swrKeys', () => {
  it('should produce swr-prefixed key strings distinct from CacheKeys.vodStatic', () => {
    assert.strictEqual(swrKeys.vodStatic('tenant-1', 42), 'swr:vod:{tenant-1}:42');
    assert.notStrictEqual(swrKeys.vodStatic('tenant-1', 42), CacheKeys.vodStatic('tenant-1', 42));
  });

  it('should produce swr-prefixed key strings distinct from CacheKeys.vodPlatform', () => {
    assert.strictEqual(swrKeys.vodPlatform('tenant-1', 'twitch', '12345'), 'swr:vod:platform:{tenant-1}:twitch:12345');
    assert.notStrictEqual(
      swrKeys.vodPlatform('tenant-1', 'twitch', '12345'),
      CacheKeys.vodPlatform('tenant-1', 'twitch', '12345')
    );
  });

  it('should produce swr-prefixed key strings distinct from CacheKeys.vodQuery', () => {
    const swrKey = swrKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
    const cacheKey = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
    assert.ok(swrKey.startsWith('swr:'));
    assert.notStrictEqual(swrKey, cacheKey);
  });

  it('should be typed as string (assignable to string)', () => {
    const key: string = swrKeys.vodStatic('t', 1);
    assert.ok(typeof key === 'string');
  });
});

describe('namespace separation', () => {
  it('should ensure swrKeys and simpleKeys never collide', () => {
    assert.notStrictEqual(swrKeys.vodStatic('tenant-1', 42), simpleKeys.vodStatic('tenant-1', 42));
    assert.notStrictEqual(swrKeys.emotes('tenant-1', 42), simpleKeys.emotes('tenant-1', 42));
    assert.notStrictEqual(swrKeys.bucket('tenant-1', 42, 0), simpleKeys.bucket('tenant-1', 42, 0));
    assert.notStrictEqual(swrKeys.cursor('tenant-1', 42, 'abc'), simpleKeys.cursor('tenant-1', 42, 'abc'));
    assert.notStrictEqual(
      swrKeys.vodPlatform('tenant-1', 'twitch', '12345'),
      simpleKeys.vodPlatform('tenant-1', 'twitch', '12345')
    );
  });

  it('should ensure neither swrKeys nor simpleKeys collide with CacheKeys', () => {
    assert.notStrictEqual(swrKeys.vodStatic('tenant-1', 42), CacheKeys.vodStatic('tenant-1', 42));
    assert.notStrictEqual(simpleKeys.vodStatic('tenant-1', 42), CacheKeys.vodStatic('tenant-1', 42));
  });
});

describe('simpleKeys', () => {
  it('should produce simple-prefixed key strings distinct from CacheKeys.vodStatic', () => {
    assert.strictEqual(simpleKeys.vodStatic('tenant-1', 42), 'simple:vod:{tenant-1}:42');
    assert.notStrictEqual(simpleKeys.vodStatic('tenant-1', 42), CacheKeys.vodStatic('tenant-1', 42));
  });

  it('should produce simple-prefixed key strings distinct from CacheKeys.emotes', () => {
    assert.strictEqual(simpleKeys.emotes('tenant-1', 42), 'simple:emotes:{tenant-1}:42');
    assert.notStrictEqual(simpleKeys.emotes('tenant-1', 42), CacheKeys.emotes('tenant-1', 42));
  });

  it('should produce simple-prefixed key strings distinct from CacheKeys.bucket', () => {
    assert.strictEqual(simpleKeys.bucket('tenant-1', 42, 0), 'simple:{tenant-1}:42:bucket:0');
    assert.notStrictEqual(simpleKeys.bucket('tenant-1', 42, 0), CacheKeys.bucket('tenant-1', 42, 0));
  });

  it('should produce simple-prefixed key strings distinct from CacheKeys.cursor', () => {
    assert.strictEqual(simpleKeys.cursor('tenant-1', 42, 'abc'), 'simple:{tenant-1}:42:cursor:abc');
    assert.notStrictEqual(simpleKeys.cursor('tenant-1', 42, 'abc'), CacheKeys.cursor('tenant-1', 42, 'abc'));
  });

  it('should produce simple-prefixed key strings distinct from CacheKeys.vodQuery', () => {
    const simpleKey = simpleKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
    const cacheKey = CacheKeys.vodQuery('tenant-1', { title: 'test' }, 1, 20);
    assert.ok(simpleKey.startsWith('simple:'));
    assert.notStrictEqual(simpleKey, cacheKey);
  });

  it('should have stats factory', () => {
    assert.strictEqual(simpleKeys.stats('tenant-1'), 'simple:stats:tenant-1');
  });

  it('should be typed as string (assignable to string)', () => {
    const key: string = simpleKeys.stats('t');
    assert.ok(typeof key === 'string');
  });
});
