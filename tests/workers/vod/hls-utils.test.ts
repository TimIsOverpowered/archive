import fsPromises from 'fs/promises';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cleanupOrphanedTmpFiles } from '../../../src/workers/vod/hls-utils.js';

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
