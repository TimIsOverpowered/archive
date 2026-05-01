import { retryWithBackoff } from './retry.js';
import { extractErrorDetails } from './error.js';
import { getLogger } from './logger.js';
import {
  HTTP_DEFAULT_ATTEMPTS,
  HTTP_DEFAULT_BASE_DELAY_MS,
  HTTP_DEFAULT_MAX_DELAY_MS,
  SEGMENT_DOWNLOAD_MAX_CONNECTIONS,
  SEGMENT_DOWNLOAD_PIPELINING,
} from '../constants.js';
import { HttpError } from './http-error.js';
import { DownloadAbortedError } from './domain-errors.js';
import { Agent, request as undiciRequest, type BodyInit as UndiciBodyInit, type Dispatcher } from 'undici';

/** Supported HTTP response types for request/safeRequest functions. */
export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';

/** Configuration options for HTTP requests. */
export interface RequestOptions<R extends ResponseType = 'json'> {
  method?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') | undefined;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  timeoutMs?: number | undefined;
  responseType?: R | undefined;
  retryOptions?:
    | {
        attempts?: number | undefined;
        baseDelayMs?: number | undefined;
        maxDelayMs?: number | undefined;
      }
    | undefined;
  logContext?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  dispatcher?: Agent | undefined;
}

/** Type-level mapping from ResponseType to the corresponding JavaScript type. */
export type RequestResult<T, R extends ResponseType> = R extends 'json'
  ? T
  : R extends 'text'
    ? string
    : R extends 'blob'
      ? Blob
      : R extends 'arrayBuffer'
        ? ArrayBuffer
        : Dispatcher.ResponseData;

/** Undici agent configured for high-concurrency segment downloads. */
export const segmentDownloadAgent = new Agent({
  connections: SEGMENT_DOWNLOAD_MAX_CONNECTIONS,
  pipelining: SEGMENT_DOWNLOAD_PIPELINING,
});

const SENSITIVE_PARAM_PATTERNS = [/^nauthsig$/i, /^nauth$/i, /token/i, /secret/i, /_key$/i];

function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAM_PATTERNS.some((pattern) => pattern.test(name));
}

function scrubSensitiveParams(url: string): string {
  try {
    const urlObj = new URL(url);

    for (const [name] of urlObj.searchParams) {
      if (isSensitiveParam(name)) {
        urlObj.searchParams.set(name, 'REDACTED');
      }
    }

    return urlObj.toString();
  } catch {
    return url;
  }
}

function prepareBodyAndHeaders(
  body: unknown,
  headers: Record<string, string>
): {
  body: BodyInit | undefined;
  headers: Record<string, string>;
} {
  if (body === undefined || body === null) {
    return { body: undefined, headers };
  }

  if (
    typeof body === 'object' &&
    !ArrayBuffer.isView(body) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof FormData) &&
    !(body instanceof Blob)
  ) {
    return {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    };
  }

  return { body: body as BodyInit, headers };
}

/**
 * Make an HTTP request with configurable response type, retry logic, and abort signals.
 * Scrubs sensitive query params (nauth, nauthsig, access_token) from URLs before logging.
 */
// Overloads for proper type inference
export function request<T = unknown>(url: string | URL, options?: RequestOptions<'json'>): Promise<T>;
export function request(url: string | URL, options: RequestOptions<'text'>): Promise<string>;
export function request(url: string | URL, options: RequestOptions<'blob'>): Promise<Blob>;
export function request(url: string | URL, options: RequestOptions<'arrayBuffer'>): Promise<ArrayBuffer>;
export function request(url: string | URL, options: RequestOptions<'response'>): Promise<Dispatcher.ResponseData>;
export async function request<T = unknown, R extends ResponseType = 'json'>(
  url: string | URL,
  options?: RequestOptions<R>
): Promise<RequestResult<T, R>> {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeoutMs = 10000,
    responseType,
    retryOptions,
    logContext = {},
    dispatcher,
  } = options ?? {};

  const actualResponseType = responseType ?? ('json' as R);

  const urlStr = url.toString();
  const scrubbedUrl = scrubSensitiveParams(urlStr);
  const startTime = Date.now();

  const { body: preparedBody, headers: finalHeaders } = prepareBodyAndHeaders(body, customHeaders);
  const externalSignal = options?.signal;

  const shouldRetry = (error: unknown): boolean => {
    if (error instanceof HttpError) {
      const { statusCode } = error;
      if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
        return false;
      }
      return true;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return externalSignal == null || !externalSignal.aborted;
    }

    return false;
  };

  try {
    const result = await retryWithBackoff(
      async () => {
        const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
        if (options?.signal) signals.push(options.signal);
        const combinedSignal = AbortSignal.any(signals);

        const undiciOpts: Record<string, unknown> = {
          method,
          headers: finalHeaders,
          signal: combinedSignal,
        };
        if (preparedBody !== undefined) {
          undiciOpts.body = preparedBody as UndiciBodyInit;
        }
        if (dispatcher !== undefined) {
          undiciOpts.dispatcher = dispatcher;
        }

        const response = await undiciRequest(urlStr, undiciOpts);

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new HttpError(
            response.statusCode,
            `HTTP ${response.statusCode}: ${((response as unknown as Record<string, unknown>).statusMessage as string) ?? ''}`
          );
        }

        let parsedData: unknown;
        switch (actualResponseType) {
          case 'json':
            parsedData = await response.body.json();
            break;
          case 'text':
            parsedData = await response.body.text();
            break;
          case 'blob':
            parsedData = new Blob([await response.body.arrayBuffer()]);
            break;
          case 'arrayBuffer':
            parsedData = await response.body.arrayBuffer();
            break;
          case 'response':
            return response;
        }

        return parsedData as RequestResult<T, R>;
      },
      {
        attempts: retryOptions?.attempts ?? HTTP_DEFAULT_ATTEMPTS,
        baseDelayMs: retryOptions?.baseDelayMs ?? HTTP_DEFAULT_BASE_DELAY_MS,
        maxDelayMs: retryOptions?.maxDelayMs ?? HTTP_DEFAULT_MAX_DELAY_MS,
        shouldRetry,
      }
    );

    return result as RequestResult<T, R>;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof Error && error.name === 'AbortError') {
      getLogger().error(
        { component: 'http-client', method, url: scrubbedUrl, duration, error: 'Download aborted' },
        'FAILED'
      );
      throw new DownloadAbortedError();
    }

    const { message } = extractErrorDetails(error);
    getLogger().error(
      { component: 'http-client', method, url: scrubbedUrl, duration, error: message, ...logContext },
      'FAILED'
    );
    throw error;
  }
}

/** Options for safeRequest, which returns a default value on failure. */
export interface SafeRequestOptions<R extends ResponseType = 'json'> extends Omit<RequestOptions<R>, 'onError'> {
  onError?: (error: unknown, url: string) => void;
}

/**
 * Make an HTTP request that returns a default value instead of throwing on failure.
 * Useful for fetching non-critical data (emotes, badges, etc.).
 */
export function safeRequest<T = unknown>(
  url: string | URL,
  defaultValue: T,
  options?: SafeRequestOptions<'json'>
): Promise<T>;
export function safeRequest(
  url: string | URL,
  defaultValue: string,
  options?: SafeRequestOptions<'text'>
): Promise<string>;
export function safeRequest(url: string | URL, defaultValue: Blob, options?: SafeRequestOptions<'blob'>): Promise<Blob>;
export function safeRequest(
  url: string | URL,
  defaultValue: ArrayBuffer,
  options?: SafeRequestOptions<'arrayBuffer'>
): Promise<ArrayBuffer>;
export function safeRequest(
  url: string | URL,
  defaultValue: Dispatcher.ResponseData,
  options?: SafeRequestOptions<'response'>
): Promise<Dispatcher.ResponseData>;
export async function safeRequest(
  url: string | URL,
  defaultValue: unknown,
  options?: SafeRequestOptions<ResponseType>
): Promise<unknown> {
  try {
    return await request(url, options as RequestOptions<'json'> | undefined);
  } catch (error) {
    options?.onError?.(error, url.toString());
    return defaultValue;
  }
}
