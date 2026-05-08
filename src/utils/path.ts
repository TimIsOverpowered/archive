import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getTmpPath, getVodPath, getLivePath } from '../config/env.js';
import { ConfigNotConfiguredError } from './domain-errors.js';
import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';

const log = childLogger({ module: 'path' });

/**
 * Normalizes a file path for cross-platform compatibility.
 * Converts platform-specific separators and resolves relative paths.
 */
export function normalizePath(basePath?: string): string | undefined {
  if (basePath == null || basePath === '') return basePath;

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

export interface VodPathOptions {
  vodId: string;
}

export interface LivePathOptions {
  streamId: string;
}

/**
 * Gets the tmp directory path for a VOD.
 * Path: {TMP_PATH}/{vodId}
 */
export function getTmpDirPath(options: VodPathOptions): string {
  const tmpPath = getTmpPath();
  if (tmpPath == null) {
    throw new ConfigNotConfiguredError('TMP_PATH is not configured');
  }
  return path.join(tmpPath, options.vodId);
}

/**
 * Gets the tmp file path for a VOD.
 * Path: {TMP_PATH}/{vodId}/{vodId}.mp4
 */
export function getTmpFilePath(options: VodPathOptions): string {
  const tmpPath = getTmpPath();
  if (tmpPath == null) {
    throw new ConfigNotConfiguredError('TMP_PATH is not configured');
  }
  return path.join(tmpPath, options.vodId, `${options.vodId}.mp4`);
}

/**
 * Gets the file path for an archived VOD.
 * Path: {VOD_PATH}/{vodId}/{vodId}.mp4
 */
export function getVodFilePath(options: VodPathOptions): string {
  const vodPath = getVodPath();
  if (vodPath == null) throw new Error('VOD_PATH is not configured');
  return path.join(vodPath, options.vodId, `${options.vodId}.mp4`);
}

/**
 * Gets the directory path for an archived VOD.
 * Path: {VOD_PATH}/{vodId}
 */
export function getVodDirPath(options: VodPathOptions): string {
  const vodPath = getVodPath();
  if (vodPath == null) throw new Error('VOD_PATH is not configured');
  return path.join(vodPath, options.vodId);
}

/**
 * Gets the file path for a live VOD.
 * Path: {LIVE_PATH}/{streamId}/{streamId}.mp4
 */
export function getLiveFilePath(options: LivePathOptions): string {
  const livePath = getLivePath();
  if (livePath == null) throw new Error('LIVE_PATH is not configured');
  return path.join(livePath, options.streamId, `${options.streamId}.mp4`);
}

/**
 * Gets the directory path for a live VOD.
 * Path: {LIVE_PATH}/{streamId}
 */
export function getLiveDirPath(options: LivePathOptions): string {
  const livePath = getLivePath();
  if (livePath == null) throw new Error('LIVE_PATH is not configured');
  return path.join(livePath, options.streamId);
}
