import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [5000, 10000, 15000];

/**
 * Copies a file from source to destination with retry logic.
 * Uses sequential I/O (maxConcurrentIOs: 1) to avoid saturating storage mount.
 * Deletes source on success.
 */
export async function finalizeToStorage(sourcePath: string, destPath: string, log: AppLogger): Promise<void> {
  const destDir = path.dirname(destPath);
  await fsPromises.mkdir(destDir, { recursive: true });

  let lastError: unknown;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      await fsPromises.copyFile(sourcePath, destPath);
      await fsPromises.unlink(sourcePath);
      log.info({ sourcePath, destPath, attempt: attempt + 1 }, 'Finalized file to storage');
      return;
    } catch (err) {
      lastError = err;
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_ATTEMPTS - 1];
      log.warn(
        { sourcePath, destPath, attempt: attempt + 1, error: extractErrorDetails(err).message },
        `Failed to finalize file to storage (attempt ${attempt + 1}/${RETRY_ATTEMPTS})`
      );
      if (attempt < RETRY_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

export interface FinalizeVodFileOptions {
  filePath: string;
  destPath: string;
  tmpDir?: string;
  saveMP4: boolean;
  log: AppLogger;
}

/**
 * Centralized finalization called by downstream workers after all processing:
 * - If saveMP4=true: copies file to destPath, then deletes tmpDir
 * - If saveMP4=false: just deletes tmpDir
 */
export async function finalizeVodFile(options: FinalizeVodFileOptions): Promise<void> {
  const { filePath, destPath, tmpDir, saveMP4, log } = options;

  if (saveMP4) {
    try {
      await finalizeToStorage(filePath, destPath, log);
    } catch (err) {
      const details = extractErrorDetails(err);
      log.error({ filePath, destPath, error: details.message }, 'Failed to finalize VOD file to storage');
      throw err;
    }
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
