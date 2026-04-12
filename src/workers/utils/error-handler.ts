import { extractErrorDetails } from '../../utils/error.js';
import type { AppLogger } from '../../utils/auto-tenant-logger.js';

export interface WorkerErrorContext {
  vodId?: string;
  jobId?: string;
  platform?: 'twitch' | 'kick';
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
export function handleWorkerError(error: unknown, log: AppLogger, context: WorkerErrorContext = {}, options: WorkerErrorHandlerOptions = {}): string {
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

/**
 * Creates a standardized try-catch wrapper for worker operations.
 *
 * @param operation - Async operation to execute
 * @param log - Logger instance
 * @param context - Error context
 * @param onError - Optional callback for error handling (e.g., update alert)
 * @returns Promise that resolves on success or throws with formatted error
 */
export async function tryWorkerOperation<T>(operation: () => Promise<T>, log: AppLogger, context: WorkerErrorContext, onError?: (errorMsg: string) => Promise<void> | void): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const errorMsg = handleWorkerError(error, log, context);

    if (onError) {
      await onError(errorMsg);
    }

    throw error;
  }
}
