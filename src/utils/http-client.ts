import { retryWithBackoff } from './retry.js';
import { extractErrorDetails } from './error.js';
import { logger } from './logger.js';
import { HTTP_DEFAULT_ATTEMPTS, HTTP_DEFAULT_BASE_DELAY_MS, HTTP_DEFAULT_MAX_DELAY_MS } from '../constants.js';
import { HttpError } from './http-error.js';

export type ResponseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';

export interface RequestOptions<R extends ResponseType = 'json'> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  responseType?: R;
  retryOptions?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  logContext?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type RequestResult<T, R extends ResponseType> = R extends 'json'
  ? T
  : R extends 'text'
    ? string
    : R extends 'blob'
      ? Blob
      : R extends 'arrayBuffer'
        ? ArrayBuffer
        : Response;

function scrubSensitiveParams(url: string): string {
  try {
    const urlObj = new URL(url);
    const sensitiveParams = ['nauth', 'nauthsig', 'access_token'];

    for (const param of sensitiveParams) {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, '[REDACTED]');
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

function shouldRetry(error: unknown): boolean {
  if (error instanceof HttpError) {
    const { statusCode } = error;
    if (statusCode === 429 || statusCode === 408 || (statusCode >= 500 && statusCode < 600)) {
      return true;
    }
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  return false;
}

// Overloads for proper type inference
export function request<T = unknown>(url: string | URL, options?: RequestOptions<'json'>): Promise<T>;
export function request(url: string | URL, options: RequestOptions<'text'>): Promise<string>;
export function request(url: string | URL, options: RequestOptions<'blob'>): Promise<Blob>;
export function request(url: string | URL, options: RequestOptions<'arrayBuffer'>): Promise<ArrayBuffer>;
export function request(url: string | URL, options: RequestOptions<'response'>): Promise<Response>;
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
  } = options ?? {};

  const actualResponseType = responseType ?? ('json' as R);

  const urlStr = url.toString();
  const scrubbedUrl = scrubSensitiveParams(urlStr);
  const startTime = Date.now();

  const { body: preparedBody, headers: finalHeaders } = prepareBodyAndHeaders(body, customHeaders);

  try {
    const result = await retryWithBackoff(
      async () => {
        const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
        if (options?.signal) signals.push(options.signal);
        const combinedSignal = AbortSignal.any(signals);

        const response = await fetch(urlStr, {
          method,
          headers: finalHeaders,
          body: preparedBody,
          signal: combinedSignal,
        });

        if (!response.ok) {
          throw new HttpError(response.status, `HTTP ${response.status}: ${response.statusText}`);
        }

        let parsedData: unknown;
        switch (actualResponseType) {
          case 'json':
            parsedData = await response.json();
            break;
          case 'text':
            parsedData = await response.text();
            break;
          case 'blob':
            parsedData = await response.blob();
            break;
          case 'arrayBuffer':
            parsedData = await response.arrayBuffer();
            break;
          case 'response':
            return response as RequestResult<T, R>;
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

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const { message } = extractErrorDetails(error);
    logger.error({ method, url: scrubbedUrl, duration, error: message, ...logContext }, '[HTTP] FAILED');
    throw error;
  }
}

export interface SafeRequestOptions<R extends ResponseType = 'json'> extends Omit<RequestOptions<R>, 'onError'> {
  onError?: (error: unknown, url: string) => void;
}

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
  defaultValue: Response,
  options?: SafeRequestOptions<'response'>
): Promise<Response>;
export function safeRequest(
  url: string | URL,
  defaultValue: unknown,
  options?: SafeRequestOptions<ResponseType>
): Promise<unknown> {
  return (async () => {
    try {
      return await request(url, options as RequestOptions<'json'> | undefined);
    } catch (error) {
      options?.onError?.(error, url.toString());
      return defaultValue;
    }
  })();
}
