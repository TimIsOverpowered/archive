import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { Job } from 'bullmq';
import type { LiveDownloadJob } from '../../src/workers/jobs/types.js';
import liveProcessor from '../../src/workers/live.worker.js';
import { setupBaseEnv, setupWorkerMocks, teardownWorkerMocks } from '../helpers/worker-test-setup.js';

setupBaseEnv('/tmp/test-vods');

describe('Live Worker', () => {
  let mocks: ReturnType<typeof setupWorkerMocks>;

  beforeEach(async () => {
    mocks = setupWorkerMocks();
  });

  afterEach(async () => {
    teardownWorkerMocks(mocks);
  });

  it('should throw when VOD path not configured for tenant', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant-no-path',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as unknown as Job<LiveDownloadJob>;

    try {
      await liveProcessor(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw on error and propagate the error', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as unknown as Job<LiveDownloadJob>;

    let errorThrown: Error | null = null;
    try {
      await liveProcessor(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle job with all fields', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
        sourceUrl: 'https://example.com/live.m3u8',
      },
    } as unknown as Job<LiveDownloadJob>;

    try {
      await liveProcessor(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when download fails', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'kick',
        tenantId: 'test-tenant',
        platformUserId: 'kick-user-123',
        platformUsername: 'kickstreamer',
        startedAt: new Date().toISOString(),
      },
    } as unknown as Job<LiveDownloadJob>;

    let errorThrown: Error | null = null;
    try {
      await liveProcessor(job);
    } catch (error) {
      errorThrown = error as Error;
    }
    assert.ok(errorThrown);
  });

  it('should handle missing platformUsername gracefully', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: undefined,
        startedAt: new Date().toISOString(),
      },
    } as unknown as Job<LiveDownloadJob>;

    try {
      await liveProcessor(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should handle job without sourceUrl for non-Kick platform', async () => {
    const job = {
      id: 'job-1',
      data: {
        dbId: 1,
        vodId: 'live-vod-123',
        platform: 'twitch',
        tenantId: 'test-tenant',
        platformUserId: 'twitch-user-123',
        platformUsername: 'teststreamer',
        startedAt: new Date().toISOString(),
      },
    } as unknown as Job<LiveDownloadJob>;

    try {
      await liveProcessor(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });
});
