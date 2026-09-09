import { strict as assert } from 'node:assert';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AppLogger } from '../../../src/utils/logger.ts';
import { PART_SUFFIX, atomicCopyFile, atomicReplaceFile } from '../../../src/workers/utils/atomic-file.ts';

const mockLog = { debug: () => {}, warn: () => {} } as unknown as AppLogger;

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'atomic-file-'));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('atomicCopyFile', () => {
  it('copies a file into place, creating parent dirs, and leaves no .part behind', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const source = path.join(dir, 'source.mp4');
    const dest = path.join(dir, 'nested', 'dest.mp4');
    await writeFile(source, 'hello world');

    await atomicCopyFile(source, dest, { log: mockLog });

    assert.equal(await readFile(dest, 'utf8'), 'hello world');
    assert.equal(await exists(`${dest}${PART_SUFFIX}`), false, 'no .part file should remain');
  });

  it('overwrites an existing destination with the new content', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const source = path.join(dir, 'source.mp4');
    const dest = path.join(dir, 'dest.mp4');
    // Pre-existing (longer) file at the destination — the exact case that breaks
    // a naive fs.rename() on Windows.
    await writeFile(dest, 'OLD CONTENT that is much longer than the replacement');
    await writeFile(source, 'NEW');

    await atomicCopyFile(source, dest, { log: mockLog });

    assert.equal(await readFile(dest, 'utf8'), 'NEW');
    assert.equal(await exists(`${dest}${PART_SUFFIX}`), false);
  });

  it('creates no destination or .part file when the source is missing', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const dest = path.join(dir, 'dest.mp4');

    await assert.rejects(atomicCopyFile(path.join(dir, 'missing.mp4'), dest, { log: mockLog }));

    assert.equal(await exists(dest), false);
    assert.equal(await exists(`${dest}${PART_SUFFIX}`), false);
  });

  it('reports progress with the running byte count and the total size', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const payload = Buffer.from('0123456789'.repeat(1000)); // 10_000 bytes
    const source = path.join(dir, 'source.bin');
    const dest = path.join(dir, 'dest.bin');
    await writeFile(source, payload);

    const seen: Array<[number, number]> = [];
    await atomicCopyFile(source, dest, {
      log: mockLog,
      onProgress: (bytesCopied, totalBytes) => {
        seen.push([bytesCopied, totalBytes]);
      },
    });

    assert.ok(seen.length > 0, 'onProgress should be called');
    const lastBytes = seen[seen.length - 1]?.[0];
    const lastTotal = seen[seen.length - 1]?.[1];
    assert.equal(lastTotal, payload.length);
    assert.equal(lastBytes, payload.length);
    assert.equal(await readFile(dest, 'utf8'), payload.toString('utf8'));
  });
});

describe('atomicReplaceFile', () => {
  it('replaces an existing final file with the part file', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const finalPath = path.join(dir, 'out.mp4');
    const partPath = `${finalPath}${PART_SUFFIX}`;
    await writeFile(finalPath, 'OLD');
    await writeFile(partPath, 'NEW');

    await atomicReplaceFile(partPath, finalPath);

    assert.equal(await readFile(finalPath, 'utf8'), 'NEW');
    assert.equal(await exists(partPath), false, 'part file should be gone after rename');
  });

  it('moves the part into place when no final file exists yet', async (t) => {
    const dir = await makeTmpDir();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const finalPath = path.join(dir, 'out.mp4');
    const partPath = `${finalPath}${PART_SUFFIX}`;
    await writeFile(partPath, 'FIRST');

    await atomicReplaceFile(partPath, finalPath);

    assert.equal(await readFile(finalPath, 'utf8'), 'FIRST');
    assert.equal(await exists(partPath), false);
  });
});
