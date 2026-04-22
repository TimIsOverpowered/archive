import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getEffectiveSplitDuration } from '../../../src/workers/youtube/validation.js';
import { YOUTUBE_MAX_DURATION } from '../../../src/constants.js';

describe('getEffectiveSplitDuration', () => {
  it('should return YOUTUBE_MAX_DURATION when configuredDuration is null', () => {
    assert.strictEqual(getEffectiveSplitDuration(null), YOUTUBE_MAX_DURATION);
  });

  it('should return YOUTUBE_MAX_DURATION when configuredDuration is undefined', () => {
    assert.strictEqual(getEffectiveSplitDuration(undefined), YOUTUBE_MAX_DURATION);
  });

  it('should return YOUTUBE_MAX_DURATION when configuredDuration is 0', () => {
    assert.strictEqual(getEffectiveSplitDuration(0), YOUTUBE_MAX_DURATION);
  });

  it('should return YOUTUBE_MAX_DURATION when configuredDuration is negative', () => {
    assert.strictEqual(getEffectiveSplitDuration(-100), YOUTUBE_MAX_DURATION);
  });

  it('should return YOUTUBE_MAX_DURATION when configuredDuration exceeds max', () => {
    assert.strictEqual(getEffectiveSplitDuration(100_000), YOUTUBE_MAX_DURATION);
  });

  it('should return YOUTUBE_MAX_DURATION when configuredDuration equals max', () => {
    assert.strictEqual(getEffectiveSplitDuration(YOUTUBE_MAX_DURATION), YOUTUBE_MAX_DURATION);
  });

  it('should return configuredDuration when within valid range', () => {
    assert.strictEqual(getEffectiveSplitDuration(3600), 3600);
  });

  it('should return configuredDuration for small valid values', () => {
    assert.strictEqual(getEffectiveSplitDuration(1), 1);
  });

  it('should return configuredDuration for values just below max', () => {
    assert.strictEqual(getEffectiveSplitDuration(YOUTUBE_MAX_DURATION - 1), YOUTUBE_MAX_DURATION - 1);
  });

  it('should return configuredDuration for large but valid values', () => {
    assert.strictEqual(getEffectiveSplitDuration(40000), 40000);
  });

  it('should handle floating point values', () => {
    assert.strictEqual(getEffectiveSplitDuration(3600.5), 3600.5);
  });

  it('should cap values slightly above max to YOUTUBE_MAX_DURATION', () => {
    assert.strictEqual(getEffectiveSplitDuration(YOUTUBE_MAX_DURATION + 1), YOUTUBE_MAX_DURATION);
  });
});
