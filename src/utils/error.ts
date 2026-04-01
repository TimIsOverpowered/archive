/**
 * Standardized error handling utilities for consistent error logging and processing across the codebase.
 */

export interface ErrorDetails {
  message: string;
  stack?: string;
}

/**
 * Extracts safe error details from any unknown value without losing type information.
 * Avoids casting to `any` which loses stack traces and structured data.
 */
export function extractErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const props = Object.getOwnPropertyNames(error);
    const errorMessage = props.includes('message') ? String((error as Record<string, unknown>).message) : JSON.stringify(error, props);
    return { message: errorMessage };
  }

  return { message: 'Unknown error occurred' };
}

/**
 * Safely executes an async function with standardized error handling.
 * Logs the error and returns fallback value or re-throws based on configuration.
 */
export async function safeAsync<T>(fn: () => Promise<T>, onError?: (err: Error) => void, fallback?: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const details = extractErrorDetails(error);

    if (onError) {
      const errObj = error instanceof Error ? error : new Error(details.message);
      onError(errObj);
    }

    if (fallback !== undefined) {
      return fallback;
    }

    throw error;
  }
}
