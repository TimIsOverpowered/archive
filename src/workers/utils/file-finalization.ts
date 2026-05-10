import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

const CHUNK_SIZE = 1024 * 1024;

export interface FinalizeFileOptions {
  filePath: string;
  destPath: string;
  tmpDir?: string;
  saveMP4?: boolean;
  log: AppLogger;
  onProgress?: (bytesCopied: number, totalBytes: number) => void;
}

/**
 * Copies a file from source to destination with streaming I/O and optional progress callback, then optionally cleans up tmpDir.
 * Deletes source on success.
 */
export async function finalizeFile(options: FinalizeFileOptions): Promise<void> {
  const { filePath, destPath, tmpDir, saveMP4 = true, log, onProgress } = options;

  if (saveMP4) {
    const destDir = path.dirname(destPath);
    await fsPromises.mkdir(destDir, { recursive: true });

    const stat = await fsPromises.stat(filePath);
    const fileSize = stat.size;

    let bytesCopied = 0;

    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
      const writeStream = fs.createWriteStream(destPath);

      readStream.on('data', (chunk: Buffer) => {
        bytesCopied += chunk.length;
        if (onProgress) {
          onProgress(bytesCopied, fileSize);
        }
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      readStream.pipe(writeStream);
    });

    if (tmpDir != null) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
      log.info({ filePath, destPath, tmpDir }, 'Finalized file to storage');
    } else {
      log.info({ filePath, destPath }, 'Finalized file to storage');
    }
  }

  if (!saveMP4 && tmpDir != null) {
    try {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
      log.debug({ tmpDir }, 'Cleaned up tmpDir');
    } catch (err) {
      const details = extractErrorDetails(err);
      log.warn({ tmpDir, error: details.message }, 'Failed to clean up tmpDir');
    }
  }
}
