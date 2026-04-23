import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CacheKeys } from '../../src/utils/cache-keys.js';

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
      const key = CacheKeys.vodQuery('tenant-1', { title: 'test', status: null }, 1, 20);
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
      const key = CacheKeys.vodQuery('tenant-1', {
        title: 'test',
        status: undefined,
        platform: 'twitch',
        tag: null,
        genre: '',
        year: 2024,
      }, 1, 20);

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
