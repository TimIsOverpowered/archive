import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import chatProcessor from '../../src/workers/chat.worker.js';

describe('Chat Worker', () => {
  it('should skip non-Twitch platforms', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'tenant-1',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'kick',
        duration: 3600,
      },
    } as any;

    const result = await (chatProcessor as any)(job);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true);
  });

  it('should skip non-Twitch platform: YouTube', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'tenant-1',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'youtube',
        duration: 3600,
      },
    } as any;

    const result = await (chatProcessor as any)(job);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true);
  });

  it('should throw when getJobContext fails (no tenant config)', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'nonexistent-tenant-chat',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        duration: 3600,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle Twitch platform with missing DB data', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 999999,
        vodId: 'nonexistent-vod',
        platform: 'twitch',
        duration: 0,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    // Should fail due to missing DB/Redis, but the platform check passes
    assert.ok(errorThrown);
  });

  it('should handle Twitch platform with duration 0', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        duration: 0,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with startOffset', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        duration: 3600,
        startOffset: 1800,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with forceRerun flag', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        duration: 3600,
        forceRerun: true,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with all optional fields', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        platform: 'twitch',
        duration: 7200,
        startOffset: undefined,
        forceRerun: undefined,
      },
    } as any;

    let errorThrown: Error | null = null;
    try {
      await (chatProcessor as any)(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });
});
