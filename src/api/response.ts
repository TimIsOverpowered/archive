import type { ApiResponse, ApiErrorResponse, PaginatedMeta } from '../types/api.js';

/** Wraps a value in a success response envelope. */
export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/** Wraps a paginated list response with metadata. */
export function okPaginated<T>(data: T[], meta: PaginatedMeta): ApiResponse<T[]> {
  return { success: true, data, meta: meta as unknown as Record<string, unknown> };
}

/** Casts an error response shape (used by middleware that sends directly). */
export function errorResponse(
  statusCode: number,
  message: string,
  code: string,
  retryAfter?: number
): ApiErrorResponse {
  const base = { success: false, statusCode, message, code } as ApiErrorResponse;
  if (retryAfter != null) {
    base.retryAfter = retryAfter;
  }
  return base;
}
