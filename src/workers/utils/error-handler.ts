import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/logger.js';
import type { Platform } from '../../types/platforms.js';

export interface WorkerErrorContext {
  vodId?: string;
  jobId?: string;
  platform?: Platform;
  tenantId?: string;
  dbId?: number;
  [key: string]: unknown;
}

export interface WorkerErrorHandlerOptions {
  maxMessageLength?: number;
  includeStack?: boolean;
}

const DEFAULT_OPTIONS: Required<WorkerErrorHandlerOptions> = {
  maxMessageLength: 500,
  includeStack: false,
};

/**
 * Standardized error handler for workers.
 * Extracts error details, logs with context, and returns formatted error message.
 *
 * @param error - The error to handle
 * @param log - Logger instance
 * @param context - Additional context for logging
 * @param options - Handler options
 * @returns Formatted error message ready for alerts
 */
export function handleWorkerError(
  error: unknown,
  log: AppLogger,
  context: WorkerErrorContext = {},
  options: WorkerErrorHandlerOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const details = extractErrorDetails(error);
  const errorMsg = details.message.substring(0, opts.maxMessageLength);

  const logContext = {
    ...context,
    error: opts.includeStack ? details.stack : errorMsg,
  };

  log.error(logContext, 'Worker error');

  return errorMsg;
}
