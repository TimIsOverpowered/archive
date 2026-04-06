import path from 'path';
import fsPromises from 'fs/promises';
import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'path' });

/**
 * Normalizes a file path for cross-platform compatibility.
 * Converts platform-specific separators and resolves relative paths.
 */
export function normalizePath(basePath?: string): string | undefined {
  if (!basePath) return basePath;

  const normalized = path.normalize(basePath);

  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ? normalized : path.resolve(normalized);
}

/**
 * Checks if a file exists at the given path.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a file if it exists, ignoring errors if the file doesn't exist.
 */
export async function deleteFileIfExists(filePath: string): Promise<void> {
  if (await fileExists(filePath)) {
    await fsPromises.unlink(filePath).catch((err) => {
      const details = extractErrorDetails(err);
      log.warn({ filePath, error: details.message }, 'Failed to delete file');
    });
  }
}
