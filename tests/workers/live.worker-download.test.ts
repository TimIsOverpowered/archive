import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { VodNotFoundError } from '../../src/utils/domain-errors.ts';
import type { HlsDownloadResult } from '../../src/workers/vod/hls-orchestrator.ts';
import type { LiveProcessorContext } from '../../src/workers/live.worker.phases.ts';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.VOD_PATH = '/tmp/test-vods';
  process.env.LIVE_PATH = '/tmp/test-live';
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
const mockDownloadHlsStream: any = mock.fn(async () => {
  throw new Error('not set');
});
const mockMarkVodOffline: any = mock.fn(async () => {});
const mockFinalizeVod: any = mock.fn(async () => {});

mock.module('../../src/workers/vod/hls-orchestrator.js', {
  namedExports: {
    downloadHlsStream: mockDownloadHlsStream,
  },
});

mock.module('../../src/services/vod-finalization.js', {
  namedExports: {
    markVodOffline: mockMarkVodOffline,
    finalizeVod: mockFinalizeVod,
  },
});

// ============================================================================
// System Under Test — dynamically imported AFTER mock.module registrations
// ============================================================================
const { runDownload } = await import('../../src/workers/live.worker.phases.ts');

function createMockCtx(overrides: Partial<LiveProcessorContext> = {}): LiveProcessorContext {
  return {
    job: {
      id: 'job-1',
      updateProgress: async () => {},
    } as any,
    config: {
      id: 'test-tenant',
      settings: {},
    } as any,
    db: {} as any,
    tenantId: 'test-tenant',
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,
    alerts: {
      progress: () => ({ title: '', description: '', status: 'warning' as const }),
    } as any,
    messageId: 'msg-123',
    dbId: 42,
    vodId: 'live-vod-123',
    platform: 'twitch',
    platformUserId: 'twitch-user-1',
    streamerName: 'TestStreamer',
    ...overrides,
  };
}

describe('runDownload — deleted VOD handling', () => {
  it('should succeed and return phase result when download completes', async () => {
    const result: HlsDownloadResult = {
      success: true,
      m3u8Path: '/tmp/test-vods/live-vod-123.m3u8',
      outputDir: '/tmp/test-vods',
      segmentCount: 10,
      finalMp4Path: '/tmp/test-vods/live-vod-123.mp4',
    };
    mockDownloadHlsStream.mock.mockImplementation(async () => result);
    mockMarkVodOffline.mock.resetCalls();

    const phaseResult = await runDownload(createMockCtx());

    assert.strictEqual(phaseResult.segmentCount, 10);
    assert.strictEqual(phaseResult.finalMp4Path, '/tmp/test-vods/live-vod-123.mp4');
    assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
  });

  it('should mark VOD offline and throw UnrecoverableError when the VOD was deleted', async () => {
    mockDownloadHlsStream.mock.mockImplementation(async () => {
      throw new VodNotFoundError('live-vod-123', 'live HLS polling');
    });
    mockMarkVodOffline.mock.resetCalls();

    await assert.rejects(runDownload(createMockCtx()), (err: unknown) => err instanceof UnrecoverableError);

    assert.strictEqual(mockMarkVodOffline.mock.callCount(), 1);
    const offlineCall = mockMarkVodOffline.mock.calls[0].arguments[0];
    assert.strictEqual(offlineCall.dbId, 42);
    assert.strictEqual(offlineCall.vodId, 'live-vod-123');
    assert.strictEqual(offlineCall.platform, 'twitch');
  });

  it('should rethrow other errors without marking the VOD offline', async () => {
    mockDownloadHlsStream.mock.mockImplementation(async () => {
      throw new Error('Live HLS polling failed after 13 consecutive errors');
    });
    mockMarkVodOffline.mock.resetCalls();

    await assert.rejects(runDownload(createMockCtx()), /consecutive errors/);

    assert.strictEqual(mockMarkVodOffline.mock.callCount(), 0);
  });

  it('should still throw UnrecoverableError when markVodOffline itself fails', async () => {
    mockDownloadHlsStream.mock.mockImplementation(async () => {
      throw new VodNotFoundError('live-vod-123', 'live HLS polling');
    });
    mockMarkVodOffline.mock.mockImplementation(async () => {
      throw new Error('DB unavailable');
    });

    await assert.rejects(runDownload(createMockCtx()), (err: unknown) => err instanceof UnrecoverableError);
  });
});
