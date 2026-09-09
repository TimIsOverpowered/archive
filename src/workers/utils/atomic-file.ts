import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.ts';
import type { AppLogger } from '../../utils/logger.ts';

const CHUNK_SIZE = 1024 * 1024;

/**
 * Suffix appended to a destination while it is being written. The final file
 * is only renamed into place once the copy/conversion has fully completed, so
 * a crashed or interrupted write leaves a `*.part` file rather than a truncated
 * final file. Deliberately distinct from the segment-level `.tmp` suffix used by
 * the HLS downloader so the two cleanup paths never collide.
 */
export const PART_SUFFIX = '.part';

export interface AtomicCopyFileOptions {
  log: AppLogger;
  /**
   * Invoked on every data chunk with the running byte count and the total
   * source size. Use it to drive progress reporting.
   */
  onProgress?: (bytesCopied: number, totalBytes: number) => void;
}

/**
 * Atomically promotes a fully-written `partPath` to `finalPath`, replacing any
 * existing file at `finalPath`.
 *
 * On POSIX, `fs.rename` atomically overwrites the destination in a single
 * syscall. On Windows, `fs.rename` cannot overwrite an existing file (it throws
 * EPERM), so the existing destination is removed first. Either way, `finalPath`
 * always holds a complete file — never a partial one.
 */
export async function atomicReplaceFile(partPath: string, finalPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await fsPromises.unlink(finalPath).catch(() => {});
  }
  await fsPromises.rename(partPath, finalPath);
}

/**
 * Atomically copies a single file from `source` to `dest`.
 *
 * Streams into `<dest>.part`, verifies the written byte size matches the source,
 * then renames into place. The destination therefore never exists in a partial
 * state: an interrupted copy leaves a `*.part` file, never a truncated final
 * file. Any failure (including a size mismatch) unlinks the `.part` and rethrows.
 */
export async function atomicCopyFile(source: string, dest: string, options: AtomicCopyFileOptions): Promise<void> {
  const { log, onProgress } = options;

  const partPath = `${dest}${PART_SUFFIX}`;
  const sourceSize = (await fsPromises.stat(source)).size;

  await fsPromises.mkdir(path.dirname(dest), { recursive: true });

  try {
    let bytesCopied = 0;
    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(source, { highWaterMark: CHUNK_SIZE });
      const writeStream = fs.createWriteStream(partPath);

      readStream.on('data', (chunk: Buffer) => {
        bytesCopied += chunk.length;
        if (onProgress) {
          onProgress(bytesCopied, sourceSize);
        }
      });
      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    });

    const writtenSize = (await fsPromises.stat(partPath)).size;
    if (writtenSize !== sourceSize) {
      throw new Error(`Atomic copy size mismatch: source=${sourceSize}B, written=${writtenSize}B`);
    }

    await atomicReplaceFile(partPath, dest);
  } catch (err) {
    await fsPromises.unlink(partPath).catch(() => {});
    const details = extractErrorDetails(err);
    log.warn({ source, dest, error: details.message }, 'Atomic copy failed');
    throw err;
  }

  log.debug({ source, dest, size: sourceSize }, 'File copied atomically');
}
