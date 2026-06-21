import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildAudioFilters,
  CLAIM_MATCH_TYPES,
  cleanupTempFiles,
  mergeBlackoutSections,
} from '../../../src/workers/dmca/dmca.js';

describe('buildAudioFilters', () => {
  it('should build mute filters for AUDIO claims', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 1484250, endMillis: 1653750 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,1484.25,1653.75)'");
  });

  it('should build mute filters for AUDIOVISUAL claims', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIOVISUAL,
        videoSegment: { startMillis: 361000, endMillis: 429500 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,361,429.5)'");
  });

  it('should skip VIDEO claims', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.VIDEO,
        videoSegment: { startMillis: 2880250, endMillis: 2885000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, '');
  });

  it('should handle mixed claim types', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.VIDEO,
        videoSegment: { startMillis: 100000, endMillis: 200000 },
      },
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 300000, endMillis: 500000 },
      },
      {
        matchType: CLAIM_MATCH_TYPES.AUDIOVISUAL,
        videoSegment: { startMillis: 600000, endMillis: 800000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,300,500)+between(t,600,800)'");
  });

  it('should handle zero start time', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 0, endMillis: 120000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,0,120)'");
  });

  it('should handle empty claims array', () => {
    const result = buildAudioFilters([]);
    assert.strictEqual(result, '');
  });

  it('should handle large millisecond values', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIOVISUAL,
        videoSegment: { startMillis: 3600000, endMillis: 7200000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,3600,7200)'");
  });

  it('should handle zero duration claims', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 50000, endMillis: 50000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,50,50)'");
  });

  it('should chain multiple claims with + operator', () => {
    const claims = [
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 100000, endMillis: 200000 },
      },
      {
        matchType: CLAIM_MATCH_TYPES.AUDIO,
        videoSegment: { startMillis: 300000, endMillis: 400000 },
      },
    ];
    const result = buildAudioFilters(claims);
    assert.strictEqual(result, "volume=0:enable='between(t,100,200)+between(t,300,400)'");
  });
});

describe('cleanupTempFiles', () => {
  it('should deduplicate files before cleaning', async () => {
    const files = ['/tmp/test1.mp4', '/tmp/test1.mp4', '/tmp/test2.mp4'];
    await assert.doesNotReject(cleanupTempFiles(files));
  });

  it('should handle empty array', async () => {
    await assert.doesNotReject(cleanupTempFiles([]));
  });

  it('should handle non-existent files gracefully', async () => {
    const uniquePath = `/tmp/nonexistent-file-${Date.now()}.mp4`;
    await assert.doesNotReject(cleanupTempFiles([uniquePath]));
  });
});

describe('mergeBlackoutSections', () => {
  it('should merge fully overlapping sections', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 100, durationSeconds: 100, endSeconds: 200 },
      { startSeconds: 120, durationSeconds: 60, endSeconds: 180 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 200);
    assert.strictEqual(result[0]!.durationSeconds, 100);
  });

  it('should merge partially overlapping sections', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 100, durationSeconds: 80, endSeconds: 180 },
      { startSeconds: 150, durationSeconds: 100, endSeconds: 250 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 250);
    assert.strictEqual(result[0]!.durationSeconds, 150);
  });

  it('should merge contiguous sections', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 100, durationSeconds: 100, endSeconds: 200 },
      { startSeconds: 200, durationSeconds: 80, endSeconds: 280 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 280);
    assert.strictEqual(result[0]!.durationSeconds, 180);
  });

  it('should leave non-overlapping sections unchanged', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 100, durationSeconds: 50, endSeconds: 150 },
      { startSeconds: 200, durationSeconds: 50, endSeconds: 250 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 150);
    assert.strictEqual(result[1]!.startSeconds, 200);
    assert.strictEqual(result[1]!.endSeconds, 250);
  });

  it('should handle empty array', () => {
    const result = mergeBlackoutSections([]);
    assert.strictEqual(result.length, 0);
  });

  it('should handle single section', () => {
    const sections = [{ startSeconds: 100, durationSeconds: 50, endSeconds: 150 }];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 150);
  });

  it('should handle reverse-sorted input', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 200, durationSeconds: 50, endSeconds: 250 },
      { startSeconds: 100, durationSeconds: 100, endSeconds: 200 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 250);
  });

  it('should handle multiple separate groups', () => {
    const sections: Array<{ startSeconds: number; durationSeconds: number; endSeconds: number }> = [
      { startSeconds: 100, durationSeconds: 100, endSeconds: 200 },
      { startSeconds: 150, durationSeconds: 50, endSeconds: 200 },
      { startSeconds: 300, durationSeconds: 50, endSeconds: 350 },
      { startSeconds: 320, durationSeconds: 80, endSeconds: 400 },
      { startSeconds: 500, durationSeconds: 50, endSeconds: 550 },
    ];
    const result = mergeBlackoutSections(sections);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0]!.startSeconds, 100);
    assert.strictEqual(result[0]!.endSeconds, 200);
    assert.strictEqual(result[1]!.startSeconds, 300);
    assert.strictEqual(result[1]!.endSeconds, 400);
    assert.strictEqual(result[2]!.startSeconds, 500);
    assert.strictEqual(result[2]!.endSeconds, 550);
  });
});
