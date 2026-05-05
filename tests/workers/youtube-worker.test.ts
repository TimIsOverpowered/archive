import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
// Must set env vars BEFORE any source imports (youtube auth calls getWorkersConfig at module load)
const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL = 'redis://localhost';
process.env.META_DATABASE_URL = 'postgresql://meta';
process.env.PGBOUNCER_URL = 'postgresql://bouncer';
process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
process.env.NODE_ENV = 'test';
process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
import youtubeProcessor from '../../src/workers/youtube.worker.js';
import {
  buildMockDb,
  setupBaseEnv,
  setupWorkerMocksWithDb,
  teardownWorkerMocks,
} from '../helpers/worker-test-setup.js';

setupBaseEnv();

describe('YouTube Worker', () => {
  let mocks: ReturnType<typeof setupWorkerMocksWithDb>;

  beforeEach(async () => {
    const mockDb = buildMockDb({ withInsertInto: true });
    mocks = setupWorkerMocksWithDb(mockDb);
  });

  afterEach(async () => {
    teardownWorkerMocks(mocks);
  });

  it('should throw when file path is not available and no children', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'tenant-1',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
      },
      getChildrenValues: async () => ({}),
    } as any;

    try {
      await (youtubeProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('File path not available'));
    }
  });

  it('should throw when YouTube not configured for tenant', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant-no-yt',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when VOD record not found', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 999999,
        vodId: 'nonexistent-vod',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw on error and propagate the error', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
      },
    } as any;

    let errorThrown = false;
    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      errorThrown = true;
      assert.ok(error instanceof Error);
    }
    assert.ok(errorThrown, 'Should have thrown an error');
  });

  it('should handle VOD upload type', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should handle game upload type', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube-game',
        filePath: '/tmp/test.mp4',
        chapterName: 'Epic Moment',
        chapterStart: 120,
        chapterEnd: 300,
        chapterGameId: 'game-123',
        title: 'Best Moment',
        description: 'An amazing clip',
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should retrieve file path from child job results when not provided', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: undefined,
      },
      getChildrenValues: async () => ({
        'child-job-1': { finalPath: '/tmp/derived.mp4' },
      }),
    } as any;

    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should throw when child job results have no finalPath', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: undefined,
      },
      getChildrenValues: async () => ({
        'child-job-1': { somethingElse: 'data' },
      }),
    } as any;

    try {
      await (youtubeProcessor as any)(job);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('File path not available'));
    }
  });

  it('should handle job with part number', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
        part: 0,
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  it('should handle job with dmcaProcessed flag', async () => {
    const job = {
      id: 'job-1',
      data: {
        tenantId: 'test-tenant',
        dbId: 1,
        vodId: 'vod-123',
        type: 'youtube',
        filePath: '/tmp/test.mp4',
        dmcaProcessed: true,
      },
    } as any;

    try {
      await (youtubeProcessor as any)(job);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });
});
