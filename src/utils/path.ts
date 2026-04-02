import path from 'path';
import fsPromises from 'fs/promises';
import { extractErrorDetails } from './error.js';

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
 * Safely joins a base config path with segments for cross-platform compatibility.
 * Handles undefined/empty paths gracefully and filters out empty segments.
 */
export function joinConfigPath(basePath?: string, ...segments: string[]): string {
  if (!basePath) return path.join(...segments);

  const normalizedBase = normalizePath(basePath)!;
  return path.join(normalizedBase, ...segments.filter((s) => s !== ''));
}

/**
 * Ensures consistent file separators in a path for cross-platform usage.
 */
export function ensureConsistentSeparators(filePath: string): string {
  return path.normalize(filePath);
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
      console.warn(`Failed to delete file ${filePath}:`, details.message);
    });
  }
}
