import path from 'path';
import fsPromises from 'fs/promises';
import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';
import { TenantConfig } from '../config/types.js';
import { ConfigNotConfiguredError } from './domain-errors.js';

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
  config: TenantConfig;
  vodId: string;
}

export interface LivePathOptions {
  config: TenantConfig;
  streamId: string;
}

/**
 * Gets the file path for an archived VOD.
 * Path: {vodPath}/{tenantId}/{vodId}.mp4
 */
export function getVodFilePath(options: VodPathOptions): string {
  const { config, vodId } = options;

  if (config.settings.vodPath == null || config.settings.vodPath === '') {
    throw new ConfigNotConfiguredError(`VOD path for tenant ${config.id}`);
  }

  return path.join(config.settings.vodPath, config.id, vodId, `${vodId}.mp4`);
}

/**
 * Gets the directory path for an archived VOD.
 * Path: {vodPath}/{tenantId}/{vodId}
 */
export function getVodDirPath(options: VodPathOptions): string {
  const { config, vodId } = options;

  if (config.settings.vodPath == null || config.settings.vodPath === '') {
    throw new ConfigNotConfiguredError(`VOD path for tenant ${config.id}`);
  }

  return path.join(config.settings.vodPath, config.id, vodId);
}

/**
 * Gets the file path for a live VOD.
 * Path: {livePath}/{tenantId}/{streamId}/{streamId}.mp4
 */
export function getLiveFilePath(options: LivePathOptions): string {
  const { config, streamId } = options;

  if (config.settings.livePath == null || config.settings.livePath === '') {
    throw new ConfigNotConfiguredError(`Live path for tenant ${config.id}`);
  }

  return path.join(config.settings.livePath, config.id, streamId, `${streamId}.mp4`);
}

/**
 * Gets the directory path for a live VOD.
 * Path: {livePath}/{tenantId}/{streamId}
 */
export function getLiveDirPath(options: LivePathOptions): string {
  const { config, streamId } = options;

  if (config.settings.livePath == null || config.settings.livePath === '') {
    throw new ConfigNotConfiguredError(`Live path for tenant ${config.id}`);
  }

  return path.join(config.settings.livePath, config.id, streamId);
}
