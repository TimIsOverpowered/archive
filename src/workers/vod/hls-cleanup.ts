import fs from 'fs/promises';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

/**
 * Cleans up HLS temporary files after successful conversion.
 * @param vodDir - Directory containing HLS files
 * @param keepHls - Whether to preserve HLS files (config setting)
 * @param log - Logger instance
 */
export async function cleanupHlsFiles(vodDir: string, keepHls: boolean, log: AppLogger): Promise<void> {
  if (keepHls) {
    log.info({ vodDir }, `HLS files preserved (saveHLS=true)`);
    return;
  }

  try {
    await fs.rm(vodDir, { recursive: true });
    log.info({ vodDir }, `Cleaned up temporary HLS directory`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      log.warn({ error: extractErrorDetails(error).message, vodDir }, `Failed to clean up HLS directory`);
    }
  }
}
