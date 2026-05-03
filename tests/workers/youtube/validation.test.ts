import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { YouTube } from '../../../src/constants.js';
import { getEffectiveSplitDuration } from '../../../src/workers/youtube/validation.js';

describe('getEffectiveSplitDuration', () => {
  it('should return YouTube.MAX_DURATION when configuredDuration is null', () => {
    assert.strictEqual(getEffectiveSplitDuration(null), YouTube.MAX_DURATION);
  });

  it('should return YouTube.MAX_DURATION when configuredDuration is undefined', () => {
    assert.strictEqual(getEffectiveSplitDuration(undefined), YouTube.MAX_DURATION);
  });

  it('should return YouTube.MAX_DURATION when configuredDuration is 0', () => {
    assert.strictEqual(getEffectiveSplitDuration(0), YouTube.MAX_DURATION);
  });

  it('should return YouTube.MAX_DURATION when configuredDuration is negative', () => {
    assert.strictEqual(getEffectiveSplitDuration(-100), YouTube.MAX_DURATION);
  });

  it('should return YouTube.MAX_DURATION when configuredDuration exceeds max', () => {
    assert.strictEqual(getEffectiveSplitDuration(100_000), YouTube.MAX_DURATION);
  });

  it('should return YouTube.MAX_DURATION when configuredDuration equals max', () => {
    assert.strictEqual(getEffectiveSplitDuration(YouTube.MAX_DURATION), YouTube.MAX_DURATION);
  });

  it('should return configuredDuration when within valid range', () => {
    assert.strictEqual(getEffectiveSplitDuration(3600), 3600);
  });

  it('should return configuredDuration for small valid values', () => {
    assert.strictEqual(getEffectiveSplitDuration(1), 1);
  });

  it('should return configuredDuration for values just below max', () => {
    assert.strictEqual(getEffectiveSplitDuration(YouTube.MAX_DURATION - 1), YouTube.MAX_DURATION - 1);
  });

  it('should return configuredDuration for large but valid values', () => {
    assert.strictEqual(getEffectiveSplitDuration(40000), 40000);
  });

  it('should handle floating point values', () => {
    assert.strictEqual(getEffectiveSplitDuration(3600.5), 3600.5);
  });

  it('should cap values slightly above max to YouTube.MAX_DURATION', () => {
    assert.strictEqual(getEffectiveSplitDuration(YouTube.MAX_DURATION + 1), YouTube.MAX_DURATION);
  });
});
