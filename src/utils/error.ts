/**
 * Standardized error handling utilities for consistent error logging and processing across the codebase.
 */

import { ZodError } from 'zod';
import { DomainError } from './domain-errors.js';
import { HttpError } from './http-error.js';

export interface ErrorDetails {
  message: string;
  stack?: string | undefined;
}

export interface FormattedError {
  statusCode: number;
  message: string;
  code: string;
  isClientError: boolean;
}

export function hasStatusCode(e: unknown): e is { statusCode: number } {
  if (typeof e !== 'object' || e === null) return false;
  const val = (e as Record<string, unknown>).statusCode;
  return 'statusCode' in e && typeof val === 'number';
}

/**
 * Extracts safe error details from any unknown value without losing type information.
 * Avoids casting to `any` which loses stack traces and structured data.
 */
export function extractErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof ZodError) {
    const message = error.issues
      .map((i) => `${i.path.join('.') !== '' ? i.path.join('.') : 'root'}: ${i.message}`)
      .join(', ');
    return { message: `Validation Error: ${message}`, stack: error.stack };
  }

  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  if (error != null && typeof error === 'object' && !Array.isArray(error)) {
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
  return context;
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

/**
 * Format an error into a consistent API error response shape.
 * Used by both production error handler and test server.
 */
export function formatErrorResponse(error: unknown): FormattedError {
  if (error instanceof HttpError || error instanceof DomainError) {
    const { statusCode, message, code } = error;
    return { statusCode, message, code, isClientError: statusCode >= 400 && statusCode < 500 };
  }

  const details = extractErrorDetails(error);
  const statusCode = hasStatusCode(error) ? error.statusCode : 500;
  return {
    statusCode,
    message: details.message,
    code: 'INTERNAL_SERVER_ERROR',
    isClientError: statusCode >= 400 && statusCode < 500,
  };
}
