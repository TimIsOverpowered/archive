import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { registerStrategy, getStrategy } from '../../../src/services/platforms/strategy.js';
import type { PlatformStrategy } from '../../../src/services/platforms/strategy.js';
import type { Platform } from '../../../src/types/platforms.js';
import { PLATFORMS } from '../../../src/types/platforms.js';

function createMockStrategy(vodId: string): PlatformStrategy {
  return {
    checkStreamStatus: async () => null,
    fetchVodMetadata: async () => null,
    createVodData: () => ({
      platform_vod_id: vodId,
      platform: PLATFORMS.TWITCH,
      title: null,
      created_at: new Date().toISOString(),
      duration: 0,
      platform_stream_id: null,
      is_live: false,
    }),
    updateVodData: () => ({}),
  };
}

describe('Platform Strategy Registry', () => {
  it('should return undefined for unregistered platform', () => {
    const result = getStrategy('twitch');
    assert.strictEqual(result, undefined);
  });

  it('should register a strategy and retrieve it', () => {
    const mockStrategy = createMockStrategy('test');
    registerStrategy('test-platform' as Platform, mockStrategy);
    const result = getStrategy('test-platform' as Platform);
    assert.strictEqual(result, mockStrategy);
  });

  it('should overwrite existing strategy for same platform', () => {
    const strategy1 = createMockStrategy('test1');
    const strategy2 = createMockStrategy('test2');
    registerStrategy('test-platform' as Platform, strategy1);
    registerStrategy('test-platform' as Platform, strategy2);
    const result = getStrategy('test-platform' as Platform);
    assert.strictEqual(result, strategy2);
    assert.notStrictEqual(result, strategy1);
  });

  it('should support registering multiple platforms', () => {
    const twitchStrategy = createMockStrategy('twitch');
    const kickStrategy = createMockStrategy('kick');
    registerStrategy('twitch', twitchStrategy);
    registerStrategy('kick', kickStrategy);
    assert.strictEqual(getStrategy('twitch'), twitchStrategy);
    assert.strictEqual(getStrategy('kick'), kickStrategy);
  });

  it('should return undefined for completely unknown platform string', () => {
    const result = getStrategy('unknown-platform-xyz' as Platform);
    assert.strictEqual(result, undefined);
  });
});
