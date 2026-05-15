import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';

const CHUNK_SIZE = 1024 * 1024;

async function getDirSize(dir: string, excludePath: string | undefined): Promise<number> {
  let size = 0;
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (fullPath === excludePath) continue;
    if (entry.isDirectory()) {
      size += await getDirSize(fullPath, excludePath);
    } else {
      try {
        const stat = await fsPromises.stat(fullPath);
        size += stat.size;
      } catch {
        /* ignore */
      }
    }
  }
  return size;
}

async function copyDirRecursive(
  src: string,
  dest: string,
  excludePath: string | undefined,
  onProgress?: (bytesCopied: number, totalBytes: number) => void
): Promise<void> {
  await fsPromises.mkdir(dest, { recursive: true });
  const entries = await fsPromises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (srcPath === excludePath) continue;
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, excludePath, onProgress);
    } else {
      let fileBytes = 0;
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(srcPath, { highWaterMark: CHUNK_SIZE });
        const writeStream = fs.createWriteStream(destPath);
        readStream.on('data', (chunk: Buffer) => {
          fileBytes += chunk.length;
        });
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        readStream.pipe(writeStream);
      });
      if (onProgress) {
        onProgress(fileBytes, 0);
      }
    }
  }
}

export interface FinalizeFileOptions {
  filePath: string;
  destPath: string;
  tmpDir?: string;
  saveMP4?: boolean;
  saveHLS?: boolean;
  hlsDestDir?: string;
  excludedPath?: string;
  log: AppLogger;
  onProgress?: (bytesCopied: number, totalBytes: number) => void;
}

/**
 * Copies files from source to destination with streaming I/O and optional progress callback, then cleans up tmpDir.
 * Handles MP4 copy, HLS directory copy, and always deletes tmpDir.
 */
export async function finalizeFile(options: FinalizeFileOptions): Promise<void> {
  const { filePath, destPath, tmpDir, saveMP4 = true, saveHLS, hlsDestDir, excludedPath, log, onProgress } = options;

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

    log.info({ filePath, destPath }, 'Finalized MP4 to storage');
  }

  if ((saveHLS ?? false) === true && hlsDestDir != null && tmpDir != null) {
    const totalSize = await getDirSize(tmpDir, excludedPath);
    let cumulativeBytes = 0;
    const progressCb =
      onProgress != null
        ? (bytesCopied: number) => {
            cumulativeBytes += bytesCopied;
            onProgress(cumulativeBytes, totalSize);
          }
        : undefined;
    await copyDirRecursive(tmpDir, hlsDestDir, excludedPath, progressCb);
    log.info({ tmpDir, hlsDestDir }, 'Finalized HLS files to storage');
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
