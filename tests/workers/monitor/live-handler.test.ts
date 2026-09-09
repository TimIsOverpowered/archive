import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.TMP_PATH = '/tmp/test-tmp';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

setupBaseEnv();

// ============================================================================
// Hoisted mocks — registered before the module under test is imported
// ============================================================================
const mockFindVodByStreamId: any = mock.fn(async () => null);
const mockFindVodByPlatformId: any = mock.fn(async () => null);
const mockMarkVodOffline: any = mock.fn(async () => {});
const mockPublishVodUpdate: any = mock.fn(async () => {});
const mockEnqueueJobWithLogging: any = mock.fn(async () => ({ jobId: 'live_hls_test-tenant_vod-9', isNew: true }));
const mockSendStreamLiveAlert: any = mock.fn(async () => {});
const mockGetJobContext: any = mock.fn(async () => ({ db: {}, config: {} }));

const queueState: { jobs: Map<string, any> } = { jobs: new Map() };
const strategyState: { strategy: any } = { strategy: null };

const mockGetStrategy: any = mock.fn(() => strategyState.strategy);
const mockRequirePlatformConfig: any = mock.fn(() => ({ platformUserId: 'user-1', platformUsername: 'streamer1' }));
const mockGetLiveDownloadQueue: any = mock.fn(() => ({
  getJob: async (id: string) => queueState.jobs.get(id),
  getJobs: async () => [],
  isPaused: async () => false,
}));
const mockGetTmpPath: any = mock.fn(() => null);

let logCalls: Array<{ level: string; message: string }> = [];

mock.module('../../../src/db/queries/vods.js', {
  namedExports: {
    findVodByStreamId: mockFindVodByStreamId,
    findVodByPlatformId: mockFindVodByPlatformId,
  },
});

mock.module('../../../src/services/vod-finalization.js', {
  namedExports: {
    markVodOffline: mockMarkVodOffline,
  },
});

mock.module('../../../src/services/cache-invalidator.js', {
  namedExports: {
    publishVodUpdate: mockPublishVodUpdate,
  },
});

mock.module('../../../src/workers/jobs/enqueue.js', {
  namedExports: {
    enqueueJobWithLogging: mockEnqueueJobWithLogging,
  },
});

mock.module('../../../src/workers/queues/queue.js', {
  namedExports: {
    getLiveDownloadQueue: mockGetLiveDownloadQueue,
    defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
  },
});

mock.module('../../../src/workers/monitor/alert-helpers.js', {
  namedExports: {
    sendStreamLiveAlert: mockSendStreamLiveAlert,
  },
});

mock.module('../../../src/workers/utils/job-context.js', {
  namedExports: {
    getJobContext: mockGetJobContext,
  },
});

mock.module('../../../src/services/platforms/index.js', {
  namedExports: {
    getStrategy: mockGetStrategy,
  },
});

mock.module('../../../src/config/types.js', {
  namedExports: {
    requirePlatformConfig: mockRequirePlatformConfig,
  },
});

mock.module('../../../src/config/env.js', {
  namedExports: {
    getTmpPath: mockGetTmpPath,
  },
});

mock.module('../../../src/utils/auto-tenant-logger.js', {
  namedExports: {
    createAutoLogger: () => ({
      info: (_ctx: unknown, message: string) => logCalls.push({ level: 'info', message }),
      debug: (_ctx: unknown, message: string) => logCalls.push({ level: 'debug', message }),
      warn: (_ctx: unknown, message: string) => logCalls.push({ level: 'warn', message }),
      error: (_ctx: unknown, message: string) => logCalls.push({ level: 'error', message }),
    }),
  },
});

// ============================================================================
// System Under Test — dynamically imported AFTER mock.module registrations
// ============================================================================
const { handlePlatformLiveCheckWithStreamStatus } = await import('../../../src/workers/monitor/live-handler.ts');

// ============================================================================
// Helpers
// ============================================================================

function makeStrategy(overrides: Record<string, unknown> = {}) {
  return {
    checkStreamStatus: async () => null,
    fetchVodObjectForLiveStream: async () => null,
    fetchVodMetadata: async () => null,
    ...overrides,
  };
}

function makeVodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    platform_vod_id: 'vod-9',
    platform: 'twitch',
    platform_stream_id: 'stream-1',
    is_live: true,
    started_at: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  };
}

const twitchLiveStatus: any = {
  type: 'live',
  id: 'stream-1',
  title: 'Test Stream',
  started_at: new Date().toISOString(),
  user_id: 'user-1',
  user_login: 'streamer1',
};

function fakeDb(updateSpy: { flipped: boolean } = { flipped: false }): any {
  return {
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => {
            updateSpy.flipped = true;
            return [];
          },
        }),
      }),
    }),
    insertInto: () => ({
      values: () => ({
        returning: () => ({
          execute: async () => [{ id: 8 }],
        }),
      }),
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('handlePlatformLiveCheckWithStreamStatus — live VOD that was deleted on the platform', () => {
  beforeEach(() => {
    logCalls = [];
    queueState.jobs.clear();
    strategyState.strategy = makeStrategy();
    mockFindVodByStreamId.mock.mockImplementation(async () => null);
    mockMarkVodOffline.mock.resetCalls();
    mockPublishVodUpdate.mock.resetCalls();
    mockEnqueueJobWithLogging.mock.resetCalls();
    mockSendStreamLiveAlert.mock.resetCalls();
    mockGetJobContext.mock.resetCalls();
  });

  describe('handleAlreadyLiveStream (VOD row has is_live=true)', () => {
    it('should mark VOD offline when the VOD object is unresolvable past the grace period', async () => {
      strategyState.strategy = makeStrategy({ fetchVodObjectForLiveStream: async () => null });
      mockFindVodByStreamId.mock.mockImplementation(async () =>
        makeVodRow({ started_at: new Date(Date.now() - 11 * 60_000) })
      );

      await handlePlatformLiveCheckWithStreamStatus(fakeDb(), 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 1);
      const offlineCall = mockMarkVodOffline.mock.calls[0].arguments[0];
      assert.strictEqual(offlineCall.dbId, 7);
      assert.strictEqual(offlineCall.vodId, 'vod-9');
      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 0);
    });

    it('should skip (not mark offline, not enqueue) when the VOD object is unresolvable within the grace period', async () => {
      strategyState.strategy = makeStrategy({ fetchVodObjectForLiveStream: async () => null });
      mockFindVodByStreamId.mock.mockImplementation(async () =>
        makeVodRow({ started_at: new Date(Date.now() - 2 * 60_000) })
      );

      await handlePlatformLiveCheckWithStreamStatus(fakeDb(), 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 0);
      assert.ok(
        logCalls.some((c) => c.message === 'Failed to fetch VOD metadata - skipping HLS download'),
        'Expected warn log for within-grace skip'
      );
    });

    it('should remove the stale live job when marking the VOD offline past the grace period', async () => {
      strategyState.strategy = makeStrategy({ fetchVodObjectForLiveStream: async () => null });
      mockFindVodByStreamId.mock.mockImplementation(async () =>
        makeVodRow({ started_at: new Date(Date.now() - 11 * 60_000) })
      );

      const removeMock = mock.fn(async () => {});
      queueState.jobs.set('live_hls_test-tenant_vod-9', {
        getState: async () => 'delayed',
        remove: removeMock,
      });

      await handlePlatformLiveCheckWithStreamStatus(fakeDb(), 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 1);
      assert.strictEqual(removeMock.mock.callCount(), 1);
    });

    it('should skip re-queueing when the live job already exists in failed state', async () => {
      strategyState.strategy = makeStrategy({
        fetchVodObjectForLiveStream: async () => ({
          id: 'vod-9',
          title: 'Test',
          createdAt: new Date().toISOString(),
          duration: 0,
          streamId: 'stream-1',
        }),
      });
      mockFindVodByStreamId.mock.mockImplementation(async () => makeVodRow());

      queueState.jobs.set('live_hls_test-tenant_vod-9', {
        getState: async () => 'failed',
      });

      await handlePlatformLiveCheckWithStreamStatus(fakeDb(), 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 0);
      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
    });

    it('should enqueue the live download when the VOD object is resolvable and no job is failed', async () => {
      strategyState.strategy = makeStrategy({
        fetchVodObjectForLiveStream: async () => ({
          id: 'vod-9',
          title: 'Test',
          createdAt: new Date().toISOString(),
          duration: 0,
          streamId: 'stream-1',
        }),
      });
      mockFindVodByStreamId.mock.mockImplementation(async () => makeVodRow());

      await handlePlatformLiveCheckWithStreamStatus(fakeDb(), 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 1);
      const enqueueCall = mockEnqueueJobWithLogging.mock.calls[0].arguments[0];
      assert.strictEqual(enqueueCall.data.dbId, 7);
      assert.strictEqual(enqueueCall.data.vodId, 'vod-9');
      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
    });
  });

  describe('handleExistingVodBecameLive (VOD row has is_live=false)', () => {
    it('should not flip the VOD to live when the VOD object is unresolvable (deleted VOD)', async () => {
      strategyState.strategy = makeStrategy({ fetchVodObjectForLiveStream: async () => null });
      mockFindVodByStreamId.mock.mockImplementation(async () => makeVodRow({ is_live: false }));

      let flipped = false;
      const db = {
        updateTable: () => ({
          set: () => ({
            where: () => ({
              execute: async () => {
                flipped = true;
                return [];
              },
            }),
          }),
        }),
      } as any;

      await handlePlatformLiveCheckWithStreamStatus(db, 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(flipped, false);
      assert.strictEqual(mockPublishVodUpdate.mock.callCount(), 0);
      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 0);
      assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
    });

    it('should flip the VOD to live and enqueue when the VOD object is resolvable', async () => {
      strategyState.strategy = makeStrategy({
        fetchVodObjectForLiveStream: async () => ({
          id: 'vod-9',
          title: 'Test',
          createdAt: new Date().toISOString(),
          duration: 0,
          streamId: 'stream-1',
        }),
      });
      mockFindVodByStreamId.mock.mockImplementation(async () => makeVodRow({ is_live: false }));

      let flipped = false;
      const db = {
        updateTable: () => ({
          set: () => ({
            where: () => ({
              execute: async () => {
                flipped = true;
                return [];
              },
            }),
          }),
        }),
      } as any;

      await handlePlatformLiveCheckWithStreamStatus(db, 'test-tenant', {} as any, twitchLiveStatus);

      assert.strictEqual(flipped, true);
      assert.strictEqual(mockPublishVodUpdate.mock.callCount(), 1);
      assert.strictEqual(mockEnqueueJobWithLogging.mock.callCount(), 1);
    });
  });
});
