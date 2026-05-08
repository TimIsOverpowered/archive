import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import HLS from 'hls-parser';
import { Hls } from '../../../src/constants.js';
import { PLATFORMS } from '../../../src/types/platforms.js';
import type { CycleTLSSession } from '../../../src/utils/cycletls.js';
import { DownloadAbortedError } from '../../../src/utils/domain-errors.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.VOD_PATH = '/tmp/test-vods';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

setupBaseEnv();

// ============================================================================
// Hoisted mocks — must be registered before the module under test is imported
// ============================================================================
const mockFsMkdir: any = mock.fn(async (_path: string, _opts: any) => {});
const mockFsWriteFile: any = mock.fn(async (_path: string, _data: string) => {});
const mockFsReadFile: any = mock.fn(async (_path: string) => mockPlaylistVariantM3u8);
const mockFsReaddir: any = mock.fn(async (_path: string) => ['seg001.ts', 'seg002.ts', 'seg003.ts', 'vod.mp4']);

const mockFetchTwitchPlaylist: any = mock.fn(async () => mockPlaylistResult);
const mockFetchKickPlaylist: any = mock.fn(async () => mockPlaylistResult);
const mockDownloadSegmentsParallel: any = mock.fn(async () => {});
const mockResolveDownloadStrategy: any = mock.fn(() => ({ type: 'fetch', abort: () => {} }));
const mockConvertHlsToMp4: any = mock.fn(async () => {});
const mockDetectFmp4FromPlaylist: any = mock.fn(() => false);
const mockCleanupHlsFiles: any = mock.fn(async () => {});
const mockSleep: any = mock.fn(async () => {});
const mockGetRetryDelay: any = mock.fn(() => 0);
const mockCreateSession: any = mock.fn(() => ({
  streamToFile: mock.fn(async () => {}),
  fetchText: mock.fn(async () => ''),
  closed: false,
  close: () => {
    sessionCloseCalled = true;
  },
}));
const mockGetVodDirPath: any = mock.fn(() => '/tmp/test-vods/test-tenant/vod-123');
const mockGetVodFilePath: any = mock.fn(() => '/tmp/test-vods/test-tenant/vod-123/vod-123.mp4');
const mockUpdateChapterDuringDownload: any = mock.fn(async () => {});
const mockUpdateVodDurationDuringDownload: any = mock.fn(async () => {});

let sessionCloseCalled = false;
let logCalls: Array<{ level: string; args: unknown[] }> = [];

const mockPlaylistResult = {
  variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXTINF:10.0,\nseg002.ts\n#EXTINF:10.0,\nseg003.ts\n#EXT-X-ENDLIST`,
  baseURL: 'https://example.com/segments',
};

const mockPlaylistVariantM3u8 = mockPlaylistResult.variantM3u8String;

mock.module('fs/promises', {
  namedExports: {
    mkdir: mockFsMkdir,
    writeFile: mockFsWriteFile,
    readFile: mockFsReadFile,
    readdir: mockFsReaddir,
  },
});

mock.module('../../../src/utils/path.js', {
  namedExports: {
    getVodDirPath: () => {
      mockGetVodDirPath();
      return '/tmp/test-vods/test-tenant/vod-123';
    },
    getVodFilePath: () => {
      mockGetVodFilePath();
      return '/tmp/test-vods/test-tenant/vod-123/vod-123.mp4';
    },
  },
});

mock.module('../../../src/utils/cycletls.js', {
  namedExports: {
    createSession: mockCreateSession,
  },
});

mock.module('../../../src/utils/delay.js', {
  namedExports: {
    sleep: mockSleep,
    getRetryDelay: mockGetRetryDelay,
  },
});

mock.module('../../../src/workers/vod/hls-utils.js', {
  namedExports: {
    downloadSegmentsParallel: mockDownloadSegmentsParallel,
    fetchTwitchPlaylist: mockFetchTwitchPlaylist,
    fetchKickPlaylist: mockFetchKickPlaylist,
    resolveDownloadStrategy: mockResolveDownloadStrategy,
  },
});

mock.module('../../../src/workers/utils/ffmpeg.js', {
  namedExports: {
    convertHlsToMp4: mockConvertHlsToMp4,
    detectFmp4FromPlaylist: mockDetectFmp4FromPlaylist,
  },
});

mock.module('../../../src/workers/vod/hls-cleanup.js', {
  namedExports: {
    cleanupHlsFiles: mockCleanupHlsFiles,
  },
});

mock.module('../../../src/services/kick/index.js', {
  namedExports: {
    updateChapterDuringDownload: mockUpdateChapterDuringDownload,
  },
});

mock.module('../../../src/workers/vod/duration-updater.js', {
  namedExports: {
    updateVodDurationDuringDownload: mockUpdateVodDurationDuringDownload,
  },
});

mock.module('../../../src/utils/auto-tenant-logger.js', {
  namedExports: {
    createAutoLogger: () => ({
      info: (...args: unknown[]) => logCalls.push({ level: 'info', args }),
      debug: (...args: unknown[]) => logCalls.push({ level: 'debug', args }),
      warn: (...args: unknown[]) => logCalls.push({ level: 'warn', args }),
      error: (...args: unknown[]) => logCalls.push({ level: 'error', args }),
    }),
  },
});

// ============================================================================
// System Under Test — Dynamically imported AFTER mock.module registrations
// ============================================================================
const { downloadHlsStream, filterNewSegments, fetchPlaylist } =
  await import('../../../src/workers/vod/hls-orchestrator.js');

// ============================================================================
// filterNewSegments — pure function unit tests
// ============================================================================

function makeSeg(uri: string, duration = 10) {
  return {
    uri,
    duration,
    mimeType: '',
    data: null,
    byterange: null,
    mediaSequenceNumber: 0,
    discontinuitySequenceNumber: 0,
    programDateTime: null,
    t: null,
    attributes: {},
  } as unknown as HLS.types.Segment;
}

describe('filterNewSegments', () => {
  it('should return all segments as new when downloadedSegments is empty', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newSegments.length, 3);
    assert.strictEqual(result.isStreamEnd, false);
    assert.strictEqual(result.newLastSegmentUri, 'seg003.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should return only new segments not in downloadedSegments', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const downloaded = new Set(['seg001.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg001.ts', 0);

    assert.strictEqual(result.newSegments.length, 2);
    assert.strictEqual(result.newSegments[0]!.uri, 'seg002.ts');
    assert.strictEqual(result.newSegments[1]!.uri, 'seg003.ts');
  });

  it('should return empty newSegments when all segments already downloaded', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 0);

    assert.strictEqual(result.newSegments.length, 0);
  });

  it('should increment noChangeCount when last segment URI matches previous', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 3);

    assert.strictEqual(result.newNoChangeCount, 4);
    assert.strictEqual(result.newLastSegmentUri, 'seg002.ts');
  });

  it('should reset noChangeCount when last segment URI changes', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 4);

    assert.strictEqual(result.newNoChangeCount, 0);
    assert.strictEqual(result.newLastSegmentUri, 'seg003.ts');
  });

  it('should set isStreamEnd when noChangeCount reaches NO_CHANGE_THRESHOLD', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD - 1);

    assert.strictEqual(result.isStreamEnd, true);
  });

  it('should set isStreamEnd when noChangeCount exceeds NO_CHANGE_THRESHOLD', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD + 10);

    assert.strictEqual(result.isStreamEnd, true);
  });

  it('should not set isStreamEnd when noChangeCount is below threshold', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD - 2);

    assert.strictEqual(result.isStreamEnd, false);
  });

  it('should handle empty segments array', () => {
    const segments: HLS.types.Segment[] = [];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newSegments.length, 0);
    assert.strictEqual(result.isStreamEnd, false);
    assert.strictEqual(result.newLastSegmentUri, '');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should handle empty last segment URI (empty string) without triggering no-change', () => {
    const segments = [makeSeg('seg001.ts')];

    const result = filterNewSegments(segments, new Set<string>(), '', 0);

    assert.strictEqual(result.newSegments.length, 1);
    assert.strictEqual(result.newLastSegmentUri, 'seg001.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should not increment noChangeCount when last segment URI is empty string', () => {
    const segments = [makeSeg('seg001.ts')];

    const result = filterNewSegments(segments, new Set<string>(), '', 0);

    assert.strictEqual(result.newLastSegmentUri, 'seg001.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should track noChangeCount from zero when first non-empty URI is seen', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newLastSegmentUri, 'seg002.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should return correct new segments with mixed downloaded/undownloaded', () => {
    const segments = [
      makeSeg('seg001.ts'),
      makeSeg('seg002.ts'),
      makeSeg('seg003.ts'),
      makeSeg('seg004.ts'),
      makeSeg('seg005.ts'),
    ];

    const downloaded = new Set(['seg001.ts', 'seg003.ts', 'seg005.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg004.ts', 0);

    assert.strictEqual(result.newSegments.length, 2);
    assert.strictEqual(result.newSegments[0]!.uri, 'seg002.ts');
    assert.strictEqual(result.newSegments[1]!.uri, 'seg004.ts');
  });

  it('should use segments.at(-1) for last URI detection', () => {
    const segments = [makeSeg('a.ts'), makeSeg('b.ts'), makeSeg('c.ts')];

    const downloaded = new Set(['a.ts', 'b.ts', 'c.ts']);
    const result = filterNewSegments(segments, downloaded, 'c.ts', 0);

    assert.strictEqual(result.newLastSegmentUri, 'c.ts');
    assert.strictEqual(result.newNoChangeCount, 1);
  });
});

// ============================================================================
// fetchPlaylist — dispatch test
// ============================================================================

describe('fetchPlaylist', () => {
  beforeEach(() => {
    mockFetchTwitchPlaylist.mock.resetCalls();
    mockFetchKickPlaylist.mock.resetCalls();
    mockFetchTwitchPlaylist.mock.mockImplementation(async () => ({
      variantM3u8String: '#EXTM3U\n#EXT-X-ENDLIST',
      baseURL: 'https://twitch.example.com',
    }));
    mockFetchKickPlaylist.mock.mockImplementation(async () => ({
      variantM3u8String: '#EXTM3U\n#EXT-X-ENDLIST',
      baseURL: 'https://kick.example.com',
    }));
  });

  it('should dispatch to fetchTwitchPlaylist for Twitch platform', async () => {
    const result = await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    assert.strictEqual(mockFetchTwitchPlaylist.mock.callCount(), 1);
    assert.strictEqual(result.variantM3u8String, '#EXTM3U\n#EXT-X-ENDLIST');
  });

  it('should dispatch to fetchKickPlaylist for Kick platform', async () => {
    const result = await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.KICK,
        sourceUrl: 'https://kick.example.com/master.m3u8',
      } as any,
      { attempts: 1 }
    );

    assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 1);
    assert.strictEqual(result.variantM3u8String, '#EXTM3U\n#EXT-X-ENDLIST');
  });

  it('should pass vodId to fetchTwitchPlaylist', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'unique-vod-id',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'unique-vod-id');
  });

  it('should pass sourceUrl and cycleTLS to fetchKickPlaylist', async () => {
    const mockSession = {
      fetchText: mock.fn(async () => ''),
      closed: false,
      close: () => {},
    } as unknown as CycleTLSSession;
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.KICK,
        sourceUrl: 'https://kick.example.com/playlist.m3u8',
        cycleTLS: mockSession,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchKickPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[1], 'https://kick.example.com/playlist.m3u8');
    assert.strictEqual(call.arguments[3], mockSession);
  });

  it('should pass retryOptions to both platform fetchers', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 5, baseDelayMs: 3000 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.deepStrictEqual(call.arguments[3], { attempts: 5, baseDelayMs: 3000 });
  });

  it('should pass tenantId to fetchTwitchPlaylist', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 'tenant-abc', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[2], 'tenant-abc');
  });
});

// ============================================================================
// downloadHlsStream — integration tests
// ============================================================================

function buildContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    config: {
      id: 'test-tenant',
      displayName: 'Test Tenant',
      createdAt: new Date(),
      database: { url: 'postgresql://test' },
      settings: {
        domainName: 'test.com',
        timezone: 'UTC',
        saveHLS: false,
        saveMP4: true,
        vodDownload: true,
        chatDownload: true,
      },
      ...overrides,
    },
    db: {} as any,
    ...overrides,
  };
}

function buildOptions(overrides: Record<string, unknown> = {}) {
  return {
    ctx: buildContext(),
    dbId: 42,
    vodId: 'vod-123',
    platform: PLATFORMS.TWITCH,
    platformUserId: 'user-1',
    isLive: false,
    ...overrides,
  };
}

describe('downloadHlsStream', () => {
  beforeEach(() => {
    sessionCloseCalled = false;
    logCalls = [];

    // Explicitly restore default positive mocked states to prevent inter-suite leakage
    mockFetchTwitchPlaylist.mock.mockImplementation(async () => mockPlaylistResult);
    mockFetchKickPlaylist.mock.mockImplementation(async () => mockPlaylistResult);
    mockDownloadSegmentsParallel.mock.mockImplementation(async () => {});
    mockGetRetryDelay.mock.mockImplementation(() => 0);
  });

  afterEach(() => {
    mockFsMkdir.mock.resetCalls();
    mockFsWriteFile.mock.resetCalls();
    mockFsReadFile.mock.resetCalls();
    mockFsReaddir.mock.resetCalls();
    mockFetchTwitchPlaylist.mock.resetCalls();
    mockFetchKickPlaylist.mock.resetCalls();
    mockDownloadSegmentsParallel.mock.resetCalls();
    mockResolveDownloadStrategy.mock.resetCalls();
    mockConvertHlsToMp4.mock.resetCalls();
    mockDetectFmp4FromPlaylist.mock.resetCalls();
    mockCleanupHlsFiles.mock.resetCalls();
    mockSleep.mock.resetCalls();
    mockGetRetryDelay.mock.resetCalls();
    mockCreateSession.mock.resetCalls();
    mockGetVodDirPath.mock.resetCalls();
    mockGetVodFilePath.mock.resetCalls();
    mockUpdateChapterDuringDownload.mock.resetCalls();
    mockUpdateVodDurationDuringDownload.mock.resetCalls();
  });

  describe('archived VOD path', () => {
    it('should download archived VOD and return correct result', async () => {
      const result = await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          platformUserId: 'user-1',
          platformUsername: 'testuser',
          isLive: false,
        })
      );

      assert.ok(result.success);
      assert.strictEqual(result.segmentCount, 4); // Readdir mock returns 4 files
      assert.strictEqual(mockFsMkdir.mock.callCount(), 1);
      assert.strictEqual(mockFsWriteFile.mock.callCount(), 1);
      assert.strictEqual(mockDownloadSegmentsParallel.mock.callCount(), 1);
      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
      assert.strictEqual(mockCleanupHlsFiles.mock.callCount(), 1);
    });

    it('should call convertHlsToMp4 with fmp4=false when detectFmp4FromPlaylist returns false', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      assert.strictEqual(mockDetectFmp4FromPlaylist.mock.callCount(), 1);
      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
    });

    it('should throw when archived VOD playlist has no segments', async () => {
      const emptyPlaylist = {
        variantM3u8String: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST',
        baseURL: 'https://example.com/segments',
      };

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => emptyPlaylist);

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false })),
        /No segments found in HLS playlist/
      );
    });

    it('should close CycleTLS session in finally block on error', async () => {
      mockDownloadSegmentsParallel.mock.mockImplementation(async () => {
        throw new Error('Download failed');
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'user-1', isLive: false })),
        /Download failed/
      );

      assert.strictEqual(sessionCloseCalled, true);
    });

    it('should not create CycleTLS session for Twitch platform', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      assert.strictEqual(mockCreateSession.mock.callCount(), 0);
    });

    it('should create CycleTLS session for Kick platform', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'user-1', isLive: false }));

      assert.strictEqual(mockCreateSession.mock.callCount(), 1);
    });
  });

  describe('live polling path', () => {
    it('should poll until stream end detected (5 consecutive no-change polls)', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const segments = pollCount <= 2 ? ['seg001.ts', 'seg002.ts'] : ['seg001.ts', 'seg002.ts', 'seg003.ts'];
        const playlistLines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
        for (const seg of segments) {
          playlistLines.push(`#EXTINF:10.0,`);
          playlistLines.push(seg);
        }
        playlistLines.push('#EXT-X-ENDLIST');

        return {
          variantM3u8String: playlistLines.join('\n'),
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.ok(pollCount > 5, `Expected at least 5 polls, got ${pollCount}`);
      assert.ok(mockSleep.mock.callCount() >= 5);
    });

    it('should call onProgress callback during live polling', async () => {
      let progressCalls = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          // Use seg999.ts so it's not in the mockFsReaddir response and gets treated as "new"
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockDownloadSegmentsParallel.mock.mockImplementation(
        async (
          _segments: any,
          _vodDir: string,
          _baseURL: string,
          _strategy: any,
          _concurrency: number,
          _retries: number,
          _log: any,
          onBatchComplete?: any
        ) => {
          onBatchComplete?.(1, 1);
        }
      );

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          isLive: true,
          onProgress: () => {
            progressCalls++;
          },
        })
      );

      assert.ok(progressCalls > 0, 'Expected onProgress to be called during live polling');
    });

    it('should close CycleTLS session in finally block on live polling error', async () => {
      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        throw new Error('Playlist fetch failed');
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, isLive: true })),
        /consecutive errors/
      );

      assert.strictEqual(sessionCloseCalled, true);
    });

    it('should call Kick-specific functions during live polling', async () => {
      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUserId: 'kick-123',
          isLive: true,
          ctx: buildContext({ kick: { enabled: true, username: 'kickuser', id: 'kick-123' } }),
        })
      );

      assert.strictEqual(
        mockUpdateChapterDuringDownload.mock.callCount(),
        5,
        'Expected updateChapterDuringDownload to be called'
      );
      assert.strictEqual(
        mockUpdateVodDurationDuringDownload.mock.callCount(),
        5,
        'Expected updateVodDurationDuringDownload to be called'
      );
    });

    it('should not call Kick-specific functions for Twitch platform', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(mockUpdateChapterDuringDownload.mock.callCount(), 0);
    });

    it('should use fetch strategy for Twitch and cycleTLS strategy for Kick', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      const strategyCall = mockResolveDownloadStrategy.mock.calls[0];
      assert.ok(strategyCall);
      assert.strictEqual(strategyCall.arguments[0], PLATFORMS.TWITCH);
    });
  });

  describe('error handling', () => {
    it('should treat DownloadAbortedError as retryable and fail after max consecutive errors', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        throw new DownloadAbortedError();
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true })),
        /consecutive errors/
      );
    });

    it('should throw after too many consecutive poll errors in live mode', async () => {
      let callCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        callCount++;
        if (callCount <= 13) {
          throw new Error('Transient error');
        }
        return mockPlaylistResult;
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true })),
        /consecutive errors/
      );
    });

    it('should log error and continue polling after transient error in live mode', async () => {
      let callCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient error');
        }
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      const errorCalls = logCalls.filter((c) => c.level === 'error');
      assert.ok(errorCalls.length > 0, 'Expected error log after transient failure');
    });
  });

  describe('Discord alert integration', () => {
    it('should include discordMessageId in result when provided', async () => {
      const result = await downloadHlsStream(
        buildOptions({ platform: PLATFORMS.TWITCH, isLive: false, discordMessageId: 'alert-msg-1' })
      );

      assert.ok(result.success);
    });

    it('should call convertHlsToMp4 with onProgress when discordMessageId is provided', async () => {
      await downloadHlsStream(
        buildOptions({ platform: PLATFORMS.TWITCH, isLive: false, discordMessageId: 'alert-msg-1' })
      );

      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
    });
  });

  describe('HLS cleanup behavior', () => {
    it('should skip HLS cleanup when saveHLS is true', async () => {
      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          isLive: false,
          ctx: buildContext({
            settings: {
              domainName: 'test.com',
              timezone: 'UTC',
              saveHLS: true,
              saveMP4: true,
              vodDownload: true,
              chatDownload: true,
            },
          }),
        })
      );

      assert.strictEqual(mockCleanupHlsFiles.mock.callCount(), 1);
      const cleanupCall = mockCleanupHlsFiles.mock.calls[0];
      assert.ok(cleanupCall);
      assert.strictEqual(cleanupCall.arguments[1], true);
    });

    it('should perform HLS cleanup when saveHLS is false', async () => {
      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          isLive: false,
          ctx: buildContext({
            settings: {
              domainName: 'test.com',
              timezone: 'UTC',
              saveHLS: false,
              saveMP4: true,
              vodDownload: true,
              chatDownload: true,
            },
          }),
        })
      );

      assert.strictEqual(mockCleanupHlsFiles.mock.callCount(), 1);
      const cleanupCall = mockCleanupHlsFiles.mock.calls[0];
      assert.ok(cleanupCall);
      assert.strictEqual(cleanupCall.arguments[1], false);
    });
  });
});
