import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isBlockingPolicy, buildMuteFilters, CLAIM_TYPES, cleanupTempFiles } from '../../../src/workers/dmca/dmca.js';
import { createAutoLogger as _createAutoLogger } from '../../../src/utils/auto-tenant-logger.js';

describe('isBlockingPolicy', () => {
  it('should return true for POLICY_TYPE_GLOBAL_BLOCK', () => {
    const claim = {
      type: CLAIM_TYPES.AUDIO,
      claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
      matchDetails: { longestMatchStartTimeSeconds: 10, longestMatchDurationSeconds: 30 },
    };
    assert.strictEqual(isBlockingPolicy(claim), true);
  });

  it('should return true for POLICY_TYPE_MOSTLY_GLOBAL_BLOCK', () => {
    const claim = {
      type: CLAIM_TYPES.VISUAL,
      claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_MOSTLY_GLOBAL_BLOCK' } },
      matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 60 },
    };
    assert.strictEqual(isBlockingPolicy(claim), true);
  });

  it('should return false for POLICY_TYPE_BLOCK', () => {
    const claim = {
      type: CLAIM_TYPES.AUDIOVISUAL,
      claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_BLOCK' } },
      matchDetails: { longestMatchStartTimeSeconds: 5, longestMatchDurationSeconds: 10 },
    };
    assert.strictEqual(isBlockingPolicy(claim), false);
  });

  it('should return false for non-blocking policies', () => {
    const claim = {
      type: CLAIM_TYPES.AUDIO,
      claimPolicy: { primaryPolicy: { policyType: 'MONETIZE' } },
      matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 30 },
    };
    assert.strictEqual(isBlockingPolicy(claim), false);
  });

  it('should return false for TRACKING policy', () => {
    const claim = {
      type: CLAIM_TYPES.AUDIO,
      claimPolicy: { primaryPolicy: { policyType: 'TRACKING' } },
      matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 15 },
    };
    assert.strictEqual(isBlockingPolicy(claim), false);
  });

  it('should return false for BLOCK_DIFFERENT_COUNTRY', () => {
    const claim = {
      type: CLAIM_TYPES.VISUAL,
      claimPolicy: { primaryPolicy: { policyType: 'BLOCK_DIFFERENT_COUNTRY' } },
      matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 45 },
    };
    assert.strictEqual(isBlockingPolicy(claim), false);
  });
});

describe('buildMuteFilters', () => {
  it('should build mute filters for blocking claims', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 10, longestMatchDurationSeconds: 30 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.deepStrictEqual(result, ["volume=0:enable='between(t,10,40)'"]);
  });

  it('should build multiple mute filters for multiple blocking claims', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 60 },
      },
      {
        type: CLAIM_TYPES.AUDIOVISUAL,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_MOSTLY_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 120, longestMatchDurationSeconds: 45 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], "volume=0:enable='between(t,0,60)'");
    assert.strictEqual(result[1], "volume=0:enable='between(t,120,165)'");
  });

  it('should skip non-blocking claims', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'MONETIZE' } },
        matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 30 },
      },
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 100, longestMatchDurationSeconds: 20 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], "volume=0:enable='between(t,100,120)'");
  });

  it('should handle zero start time', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 120 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result[0], "volume=0:enable='between(t,0,120)'");
  });

  it('should handle empty claims array', () => {
    const result = buildMuteFilters([]);
    assert.deepStrictEqual(result, []);
  });

  it('should handle claims with large duration values', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 3600, longestMatchDurationSeconds: 7200 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result[0], "volume=0:enable='between(t,3600,10800)'");
  });

  it('should handle claims with zero duration', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 50, longestMatchDurationSeconds: 0 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result[0], "volume=0:enable='between(t,50,50)'");
  });

  it('should skip mixed blocking and non-blocking claims correctly', () => {
    const claims = [
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'MONETIZE' } },
        matchDetails: { longestMatchStartTimeSeconds: 0, longestMatchDurationSeconds: 10 },
      },
      {
        type: CLAIM_TYPES.AUDIO,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 20, longestMatchDurationSeconds: 30 },
      },
      {
        type: CLAIM_TYPES.VISUAL,
        claimPolicy: { primaryPolicy: { policyType: 'TRACKING' } },
        matchDetails: { longestMatchStartTimeSeconds: 50, longestMatchDurationSeconds: 10 },
      },
      {
        type: CLAIM_TYPES.AUDIOVISUAL,
        claimPolicy: { primaryPolicy: { policyType: 'POLICY_TYPE_MOSTLY_GLOBAL_BLOCK' } },
        matchDetails: { longestMatchStartTimeSeconds: 100, longestMatchDurationSeconds: 5 },
      },
    ];
    const result = buildMuteFilters(claims);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], "volume=0:enable='between(t,20,50)'");
    assert.strictEqual(result[1], "volume=0:enable='between(t,100,105)'");
  });
});

describe('cleanupTempFiles', () => {
  it('should deduplicate files before cleaning', async () => {
    const files = ['/tmp/test1.mp4', '/tmp/test1.mp4', '/tmp/test2.mp4'];
    // cleanupTempFiles should not throw even if files don't exist
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
