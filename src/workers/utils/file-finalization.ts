import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [5000, 10000, 15000];

export interface FinalizeFileOptions {
  filePath: string;
  destPath: string;
  tmpDir?: string;
  saveMP4?: boolean;
  log: AppLogger;
}

/**
 * Copies a file from source to destination with retry logic, then optionally cleans up tmpDir.
 * Uses sequential I/O (maxConcurrentIOs: 1) to avoid saturating storage mount.
 * Deletes source on success.
 */
export async function finalizeFile(options: FinalizeFileOptions): Promise<void> {
  const { filePath, destPath, tmpDir, saveMP4 = true, log } = options;

  if (saveMP4) {
    const destDir = path.dirname(destPath);
    await fsPromises.mkdir(destDir, { recursive: true });

    let lastError: unknown;

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        await fsPromises.copyFile(filePath, destPath);
        await fsPromises.unlink(filePath);
        log.info({ filePath, destPath, attempt: attempt + 1 }, 'Finalized file to storage');
        return;
      } catch (err) {
        lastError = err;
        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_ATTEMPTS - 1];
        log.warn(
          { filePath, destPath, attempt: attempt + 1, error: extractErrorDetails(err).message },
          `Failed to finalize file to storage (attempt ${attempt + 1}/${RETRY_ATTEMPTS})`
        );
        if (attempt < RETRY_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  if (tmpDir != null) {
    try {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
      log.debug({ tmpDir }, 'Cleaned up tmpDir');
    } catch (err) {
      const details = extractErrorDetails(err);
      log.warn({ tmpDir, error: details.message }, 'Failed to clean up tmpDir');
    }
  }
}
