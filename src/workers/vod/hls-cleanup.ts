import fs from 'fs/promises';
import pathMod from 'path';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

/**
 * Cleans up HLS temporary files after successful conversion.
 *
 * Moves the final MP4 out to a temp path in the parent directory,
 * deletes the entire vodDir recursively (fast native operation),
 * recreates the directory, then moves the MP4 back.
 *
 * This is significantly faster than per-file deletion for VODs with
 * thousands of segments, as fs.rm({ recursive }) runs in native code.
 *
 * @param vodDir - Directory containing HLS files
 * @param keepHls - Whether to preserve HLS files (config setting)
 * @param finalMp4Path - Full path to the final MP4 to preserve
 * @param log - Logger instance
 */
export async function cleanupHlsFiles(
  vodDir: string,
  keepHls: boolean,
  finalMp4Path: string,
  log: AppLogger
): Promise<void> {
  if (keepHls) {
    log.info({ vodDir }, `HLS files preserved (saveHLS=true)`);
    return;
  }

  const parentDir = pathMod.dirname(vodDir);
  const keepFilename = pathMod.basename(finalMp4Path);
  const tempPath = pathMod.join(parentDir, `.tmp-${keepFilename}`);

  try {
    await fs.rename(finalMp4Path, tempPath);
    await fs.rm(vodDir, { recursive: true });
    await fs.mkdir(vodDir);
    await fs.rename(tempPath, finalMp4Path);

    log.info({ vodDir }, `Cleaned up HLS segment files`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      log.warn({ error: extractErrorDetails(error).message, vodDir }, `Failed to clean up HLS directory`);
    }
  }
}
