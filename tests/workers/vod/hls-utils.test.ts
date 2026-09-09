import { strict as assert } from 'node:assert';
import fsPromises from 'node:fs/promises';
import { describe, it } from 'node:test';
import type HLS from 'hls-parser';
import { HttpError } from '../../../src/utils/http-error.ts';
import type { AppLogger } from '../../../src/utils/logger.ts';
import {
  buildTwitchVariantCandidates,
  cleanupOrphanedTmpFiles,
  fetchFirstAvailableVariant,
} from '../../../src/workers/vod/hls-utils.ts';

describe('cleanupOrphanedTmpFiles', () => {
  it('should not throw when directory is empty', async () => {
    const mockReaddir = fsPromises.readdir;
    const files: string[] = [];

    (fsPromises as any).readdir = async () => files;

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await assert.doesNotReject(cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any));

    (fsPromises as any).readdir = mockReaddir;
  });

  it('should remove .tmp files', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const removedFiles: string[] = [];

    (fsPromises as any).readdir = async () => ['segment1.ts', 'segment2.tmp', 'playlist.m3u8', 'data.tmp'];
    (fsPromises as any).unlink = async (path: string) => {
      if (path.endsWith('.tmp')) {
        removedFiles.push(path);
      }
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(removedFiles.length, 2);
    assert.ok(removedFiles.some((f) => f.includes('segment2.tmp')));
    assert.ok(removedFiles.some((f) => f.includes('data.tmp')));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should skip non-.tmp files', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    let unlinkCalled = false;

    (fsPromises as any).readdir = async () => ['segment1.ts', 'playlist.m3u8'];
    (fsPromises as any).unlink = async () => {
      unlinkCalled = true;
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(unlinkCalled, false);

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should handle unlink errors gracefully', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    let warnCalled = false;

    (fsPromises as any).readdir = async () => ['segment.tmp'];
    (fsPromises as any).unlink = async () => {
      throw new Error('Permission denied');
    };

    const mockLog = {
      debug: () => {},
      warn: (ctx: any) => {
        warnCalled = true;
        assert.ok(ctx.error);
      },
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(warnCalled, true);

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should handle directory read errors gracefully', async () => {
    const mockReaddir = fsPromises.readdir;
    let warnCalled = false;

    (fsPromises as any).readdir = async () => {
      throw new Error('ENOENT');
    };

    const mockLog = {
      debug: () => {},
      warn: (ctx: any) => {
        warnCalled = true;
        assert.ok(ctx.error);
      },
    };

    await cleanupOrphanedTmpFiles('/nonexistent-directory', mockLog as any);

    assert.strictEqual(warnCalled, true);

    (fsPromises as any).readdir = mockReaddir;
  });

  it('should only clean .tmp files, not .tmp.bak or other extensions', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const removedFiles: string[] = [];

    (fsPromises as any).readdir = async () => ['file.tmp', 'file.tmp.bak', 'file.backup.tmp.old'];
    (fsPromises as any).unlink = async (path: string) => {
      if (path.endsWith('.tmp')) {
        removedFiles.push(path);
      }
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(removedFiles.length, 1);
    assert.ok(removedFiles[0]?.endsWith('.tmp'));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should log debug message for each cleaned file', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const debugMessages: string[] = [];

    (fsPromises as any).readdir = async () => ['segment.tmp'];
    (fsPromises as any).unlink = async () => {};

    const mockLog = {
      debug: (_ctx: unknown, msg: string) => {
        debugMessages.push(msg);
      },
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.ok(debugMessages.some((m) => m.includes('Cleaned up orphaned')));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });
});

describe('buildTwitchVariantCandidates', () => {
  it('should only return the listed chunked variant and the 1080p transcode', () => {
    const hash = '6f30d0199276004cf00a_pokelawls_321334694874_1788878469';
    const base = `https://d1m7jfoe9zdc1j.cloudfront.net/${hash}`;
    const suffix = 'index-muted-JD921S70JZ.m3u8';

    const variants = [
      { uri: `${base}/chunked/${suffix}`, resolution: { width: 2560, height: 1440 } },
      { uri: `${base}/1080p60/${suffix}`, resolution: { width: 1920, height: 1080 } },
      { uri: `${base}/720p60/${suffix}`, resolution: { width: 1280, height: 720 } },
      { uri: `${base}/480p30/${suffix}`, resolution: { width: 852, height: 480 } },
    ] as unknown as HLS.types.Variant[];

    const candidates = buildTwitchVariantCandidates(variants);

    assert.deepEqual(candidates, [`${base}/chunked/${suffix}`, `${base}/1080p60/${suffix}`]);
  });

  it('should derive the chunked URL from the first variant and include only 1080p as fallback', () => {
    const hash = 'b7296bfc5d0b623ebf9c_pokelawls_321093354201_1787951067';
    const base = `https://d1m7jfoe9zdc1j.cloudfront.net/${hash}`;
    const suffix = 'index-muted-W8LY749YU8.m3u8';

    const variants = [
      { uri: `${base}/1080p60/${suffix}`, resolution: { width: 1920, height: 1080 } },
      { uri: `${base}/720p60/${suffix}`, resolution: { width: 1280, height: 720 } },
    ] as unknown as HLS.types.Variant[];

    const candidates = buildTwitchVariantCandidates(variants);

    assert.deepEqual(candidates, [`${base}/chunked/${suffix}`, `${base}/1080p60/${suffix}`]);
  });

  it('should only return the chunked variant when no 1080p transcode is present', () => {
    const variants = [
      { uri: 'https://cdn.example.com/vod/chunked/index.m3u8', resolution: { width: 2560, height: 1440 } },
      { uri: 'https://cdn.example.com/vod/720p60/index.m3u8', resolution: { width: 1280, height: 720 } },
    ] as unknown as HLS.types.Variant[];

    const candidates = buildTwitchVariantCandidates(variants);

    assert.deepEqual(candidates, ['https://cdn.example.com/vod/chunked/index.m3u8']);
  });

  it('should deduplicate and skip empty URIs', () => {
    const variants = [
      { uri: 'https://cdn.example.com/vod/chunked/index.m3u8', resolution: { width: 2560, height: 1440 } },
      { uri: 'https://cdn.example.com/vod/1080p60/index.m3u8', resolution: { width: 1920, height: 1080 } },
      { uri: 'https://cdn.example.com/vod/1080p60/index.m3u8', resolution: { width: 1920, height: 1080 } },
      { uri: '' },
    ] as unknown as HLS.types.Variant[];

    const candidates = buildTwitchVariantCandidates(variants);

    assert.deepEqual(candidates, [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ]);
  });
});

describe('fetchFirstAvailableVariant', () => {
  const mockLog = { debug: () => {}, warn: () => {}, error: () => {} } as unknown as AppLogger;

  it('should fall back to the next variant when the chunked one 403s', async () => {
    const candidates = [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ];
    const calls: string[] = [];

    const fetchVariant = async (url: string) => {
      calls.push(url);
      if (url.includes('chunked')) throw new HttpError(403, 'HTTP 403: ');
      return 'MEDIA_PLAYLIST';
    };

    const result = await fetchFirstAvailableVariant(candidates, fetchVariant, mockLog, 'vod123');

    assert.equal(result.variantM3u8String, 'MEDIA_PLAYLIST');
    assert.equal(result.baseURL, 'https://cdn.example.com/vod/1080p60');
    assert.deepEqual(calls, [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ]);
  });

  it('should return the first candidate when it succeeds', async () => {
    const candidates = [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ];
    const calls: string[] = [];

    const fetchVariant = async (url: string) => {
      calls.push(url);
      return 'CHUNKED_PLAYLIST';
    };

    const result = await fetchFirstAvailableVariant(candidates, fetchVariant, mockLog, 'vod123');

    assert.equal(result.variantM3u8String, 'CHUNKED_PLAYLIST');
    assert.equal(result.baseURL, 'https://cdn.example.com/vod/chunked');
    assert.deepEqual(calls, ['https://cdn.example.com/vod/chunked/index.m3u8']);
  });

  it('should rethrow non-403 errors without falling back', async () => {
    const candidates = [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ];
    const calls: string[] = [];

    const fetchVariant = async (url: string) => {
      calls.push(url);
      if (url.includes('chunked')) throw new HttpError(500, 'HTTP 500: ');
      return 'SHOULD_NOT_REACH';
    };

    await assert.rejects(
      fetchFirstAvailableVariant(candidates, fetchVariant, mockLog, 'vod123'),
      (err: unknown) => err instanceof HttpError && err.statusCode === 500
    );

    assert.deepEqual(calls, ['https://cdn.example.com/vod/chunked/index.m3u8']);
  });

  it('should throw the last 403 error when every candidate is unavailable', async () => {
    const candidates = [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ];
    const calls: string[] = [];

    const fetchVariant = async (url: string) => {
      calls.push(url);
      throw new HttpError(403, 'HTTP 403: ');
    };

    await assert.rejects(
      fetchFirstAvailableVariant(candidates, fetchVariant, mockLog, 'vod123'),
      (err: unknown) => err instanceof HttpError && err.statusCode === 403
    );

    assert.deepEqual(calls, [
      'https://cdn.example.com/vod/chunked/index.m3u8',
      'https://cdn.example.com/vod/1080p60/index.m3u8',
    ]);
  });
});
