/** Unified API response envelope types for consistent client-side discrimination. */

/** Success response with optional metadata (pagination, rate limits, etc.). */
export interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/** Error response matching the global error handler output. */
export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  code: string;
  retryAfter?: number;
}

/** Union type for any API endpoint return value. */
export type ApiResult<T> = ApiResponse<T> | ApiErrorResponse;

/** Metadata shape for paginated list responses. */
export interface PaginatedMeta {
  page: number;
  limit: number;
  total: number;
}
