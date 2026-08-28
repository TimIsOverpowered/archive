import { strict as assert } from 'node:assert';
import path from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';
import { resetEnvConfig } from '../../../../../src/config/env.ts';
import { SOURCE_TYPES } from '../../../../../src/types/platforms.ts';

// Storage path env (tests/setup.ts also sets these); kept here for self-containment.
process.env.TMP_PATH = '/tmp/test-tmp';
process.env.VOD_PATH = '/tmp/test-vods';
process.env.LIVE_PATH = '/tmp/test-live';

// Path fixtures
const LIVE_STORAGE = '/tmp/test-live/tenant-1/stream-1/stream-1.mp4';
const VOD_STORAGE = '/tmp/test-vods/tenant-1/vod-123/vod-123.mp4';
const TMP_FILE = '/tmp/test-tmp/tenant-1/vod-123/vod-123.mp4';
const TMP_DIR = '/tmp/test-tmp/tenant-1/vod-123';
const VOD_HLS_DIR = '/tmp/test-vods/tenant-1/vod-123/hls';
const VOD_HLS_M3U8 = path.join(VOD_HLS_DIR, 'vod-123.m3u8');

// Mock state
let existingPaths = new Set<string>();
const copyCalls: any[] = [];
const downloadCalls: any[] = [];

const mockFileExists: any = mock.fn(async (p: string) => existingPaths.has(p));
const mockQueueFileCopy: any = mock.fn(async (opts: any) => {
  copyCalls.push(opts);
  return 'copy-job-1';
});
const mockTriggerVodDownload: any = mock.fn(async (opts: any) => {
  downloadCalls.push(opts);
  return 'download-job-1';
});
const mockFindVodById: any = mock.fn(async () => ({
  id: 42,
  duration: 3600,
  platform_vod_id: 'vod-123',
  platform_stream_id: 'stream-1',
}));
const mockGetMetadata: any = mock.fn(async () => ({ duration: 3600 }));

// Hoisted module mocks — must be registered before the module under test is imported.
mock.module('../../../../../src/config/types.js', {
  namedExports: {
    requirePlatformConfig: () => ({ platformUserId: 'u-1', platformUsername: 'user-1' }),
  },
});
mock.module('../../../../../src/db/queries/vods.js', {
  namedExports: { findVodById: mockFindVodById },
});
mock.module('../../../../../src/utils/path.js', {
  namedExports: {
    fileExists: mockFileExists,
    getTmpFilePath: () => TMP_FILE,
    getTmpDirPath: () => TMP_DIR,
    getVodFilePath: () => VOD_STORAGE,
    getVodHlsDirPath: () => VOD_HLS_DIR,
    getLiveFilePath: () => LIVE_STORAGE,
  },
});
mock.module('../../../../../src/workers/jobs/copy.job.js', {
  namedExports: { queueFileCopy: mockQueueFileCopy },
});
mock.module('../../../../../src/workers/jobs/vod.job.js', {
  namedExports: { triggerVodDownload: mockTriggerVodDownload },
});
mock.module('../../../../../src/workers/utils/ffmpeg.js', {
  namedExports: { getMetadata: mockGetMetadata },
});
mock.module('../../../../../src/api/routes/admin/utils/vod-records.js', {
  namedExports: { refreshVodRecord: async () => null },
});
// tenant-platform is imported only for its TenantPlatformContext type; mock it so the
// real module (and its db/redis side-effect imports) is never loaded.
mock.module('../../../../../src/api/middleware/tenant-platform.js', {
  namedExports: { TenantPlatformContext: {} },
});

// System Under Test — dynamically imported AFTER mock.module registrations.
const { ensureVodDownload } = await import('../../../../../src/api/routes/admin/utils/vod-downloads.ts');

const ctx: any = { tenantId: 'tenant-1', platform: 'twitch', db: {}, config: {} };
const log: any = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

describe('ensureVodDownload (live)', () => {
  beforeEach(() => {
    existingPaths = new Set<string>();
    copyCalls.length = 0;
    downloadCalls.length = 0;
    resetEnvConfig();
  });

  it('enqueues a storage->tmp copy and returns the tmp path + workDir when the live file is in storage', async () => {
    existingPaths = new Set([LIVE_STORAGE]);

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.LIVE, log });

    assert.strictEqual(res.jobId, null);
    assert.strictEqual(res.filePath, TMP_FILE);
    assert.strictEqual(res.copyJobId, 'copy-job-1');
    assert.strictEqual(res.workDir, TMP_DIR);
    assert.strictEqual(res.copiedFromStorage, true);
    assert.strictEqual(copyCalls.length, 1);
    assert.strictEqual(copyCalls[0].sourcePath, LIVE_STORAGE);
    assert.strictEqual(copyCalls[0].destPath, TMP_FILE);
    assert.strictEqual(downloadCalls.length, 0);
  });

  it('returns the tmp path without a copy job when a valid copy already exists in tmp', async () => {
    existingPaths = new Set([TMP_FILE]);

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.LIVE, log });

    assert.strictEqual(res.jobId, null);
    assert.strictEqual(res.filePath, TMP_FILE);
    assert.strictEqual(res.copyJobId, undefined);
    assert.strictEqual(res.workDir, TMP_DIR);
    assert.strictEqual(res.copiedFromStorage, undefined);
    assert.strictEqual(copyCalls.length, 0);
    assert.strictEqual(downloadCalls.length, 0);
  });

  it('returns the storage path with no jobs when no valid live file exists', async () => {
    existingPaths = new Set<string>();

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.LIVE, log });

    assert.strictEqual(res.jobId, null);
    assert.strictEqual(res.filePath, LIVE_STORAGE);
    assert.strictEqual(res.copyJobId, undefined);
    assert.strictEqual(res.workDir, undefined);
    assert.strictEqual(copyCalls.length, 0);
    assert.strictEqual(downloadCalls.length, 0);
  });

  it('still enqueues a storage->tmp copy for VOD type (regression)', async () => {
    existingPaths = new Set([VOD_STORAGE]);

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.VOD, log });

    assert.strictEqual(res.jobId, null);
    assert.strictEqual(res.filePath, TMP_FILE);
    assert.strictEqual(res.copyJobId, 'copy-job-1');
    assert.strictEqual(res.workDir, TMP_DIR);
    assert.strictEqual(res.copiedFromStorage, true);
    assert.strictEqual(copyCalls.length, 1);
    assert.strictEqual(copyCalls[0].sourcePath, VOD_STORAGE);
    assert.strictEqual(downloadCalls.length, 0);
  });

  it('flags copiedFromStorage when copying an existing HLS directory from storage', async () => {
    existingPaths = new Set([VOD_HLS_M3U8]);

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.VOD, log });

    assert.strictEqual(res.jobId, null);
    assert.strictEqual(res.copyJobId, 'copy-job-1');
    assert.strictEqual(res.workDir, TMP_DIR);
    assert.strictEqual(res.copiedFromStorage, true);
    assert.strictEqual(copyCalls.length, 1);
    assert.strictEqual(copyCalls[0].isHlsCopy, true);
    assert.strictEqual(copyCalls[0].sourcePath, VOD_HLS_DIR);
    assert.strictEqual(downloadCalls.length, 0);
  });

  it('leaves copiedFromStorage unset when a fresh download is queued', async () => {
    existingPaths = new Set<string>();

    const res = await ensureVodDownload({ ctx, dbId: 42, vodId: 'vod-123', type: SOURCE_TYPES.VOD, log });

    assert.strictEqual(res.jobId, 'download-job-1');
    assert.strictEqual(res.copyJobId, undefined);
    assert.strictEqual(res.workDir, TMP_DIR);
    assert.strictEqual(res.copiedFromStorage, undefined);
    assert.strictEqual(copyCalls.length, 0);
    assert.strictEqual(downloadCalls.length, 1);
  });
});
