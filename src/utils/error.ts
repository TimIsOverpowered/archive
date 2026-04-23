/**
 * Standardized error handling utilities for consistent error logging and processing across the codebase.
 */

import { ZodError } from 'zod';

export interface ErrorDetails {
  message: string;
  stack?: string | undefined;
}

/**
 * Extracts safe error details from any unknown value without losing type information.
 * Avoids casting to `any` which loses stack traces and structured data.
 */
export function extractErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof ZodError) {
    const message = error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join(', ');
    return { message: `Validation Error: ${message}`, stack: error.stack };
  }

  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const props = Object.getOwnPropertyNames(error);
    const errorMessage = props.includes('message')
      ? String((error as Record<string, unknown>).message)
      : JSON.stringify(error, props);
    return { message: errorMessage };
  }

  return { message: 'Unknown error occurred' };
}

/**
 * Creates a standardized error logging context object.
 * Use this to ensure consistent error logging across the codebase.
 *
 * @param error - The error to extract details from
 * @param additionalContext - Optional additional context to include in the log object
 * @returns A log context object with the error message
 */
export function createErrorContext(
  error: unknown,
  additionalContext?: Record<string, unknown>
): { error: string } & Record<string, unknown> {
  const details = extractErrorDetails(error);
  const context = { ...additionalContext, error: details.message };
  return context as { error: string } & Record<string, unknown>;
}

/**
 * Throws an error if the HTTP response is not ok.
 * Standardizes HTTP error handling across the codebase.
 */
export function throwOnHttpError(response: Response, context: string = 'HTTP request'): asserts response is Response {
  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status} ${response.statusText}`);
  }
}
