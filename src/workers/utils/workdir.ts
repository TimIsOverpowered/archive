import fsPromises from 'node:fs/promises';
import { extractErrorDetails } from '../../utils/error.ts';
import type { AppLogger } from '../../utils/logger.ts';

/**
 * Recursively removes a worker's temporary work directory.
 *
 * Intended for cleanup after a job has permanently failed (retries exhausted),
 * so partial downloads are not left on disk forever. Uses `force` so it is safe
 * to call even when the directory is already gone (e.g. a parent and child job
 * both reaping the same dir). Never throws.
 */
export async function reapWorkDir(workDir: string | undefined, log: AppLogger): Promise<void> {
  if (workDir == null || workDir === '') return;

  try {
    await fsPromises.rm(workDir, { recursive: true, force: true });
    log.info({ workDir }, 'Reaped work dir after permanent job failure');
  } catch (err) {
    log.warn({ workDir, error: extractErrorDetails(err).message }, 'Failed to reap work dir');
  }
}
