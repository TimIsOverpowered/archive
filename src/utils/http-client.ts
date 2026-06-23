import { Agent, Pool, request as undiciRequest, type Dispatcher } from 'undici';
import { Http, HttpPools, Twitch } from '../constants.js';
import { DownloadAbortedError } from './domain-errors.js';
import { extractErrorDetails } from './error.js';
import { HttpError } from './http-error.js';
import { getLogger } from './logger.js';
import { retryWithBackoff } from './retry.js';

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
        shouldRetry?: ((error: unknown, attempt: number) => boolean) | undefined;
      }
    | undefined;
  logContext?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  dispatcher?: Dispatcher | undefined;
  parseReviver?: (key: string, value: unknown) => unknown;
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
  connections: Http.SEGMENT_DOWNLOAD_MAX_CONNECTIONS,
  pipelining: Http.SEGMENT_DOWNLOAD_PIPELINING,
});

/** Persistent pool for Twitch GraphQL API — handles chapters, comments, playback tokens. */
const twitchGqlPool = new Pool('https://gql.twitch.tv', {
  connections: HttpPools.TWITCH_GQL_MAX_CONNECTIONS,
  pipelining: 1,
  connectTimeout: Http.CONNECT_TIMEOUT_MS,
  keepAliveTimeout: Http.KEEP_ALIVE_TIMEOUT_MS,
});

/** Persistent pool for Twitch Helix REST API. */
const twitchApiPool = new Pool('https://api.twitch.tv', {
  connections: HttpPools.TWITCH_API_MAX_CONNECTIONS,
  pipelining: 1,
  connectTimeout: Http.CONNECT_TIMEOUT_MS,
  keepAliveTimeout: Http.KEEP_ALIVE_TIMEOUT_MS,
});

/** Persistent pool for Twitch Usher (HLS playlists). */
const twitchUsherPool = new Pool(Twitch.USHER_ORIGIN, {
  connections: HttpPools.TWITCH_USHER_MAX_CONNECTIONS,
  pipelining: 1,
  connectTimeout: Http.CONNECT_TIMEOUT_MS,
  keepAliveTimeout: Http.KEEP_ALIVE_TIMEOUT_MS,
});

/** Persistent pool for Discord webhook alerts. */
const discordPool = new Pool('https://discord.com', {
  connections: HttpPools.DISCORD_MAX_CONNECTIONS,
  pipelining: 1,
  connectTimeout: Http.CONNECT_TIMEOUT_MS,
  keepAliveTimeout: Http.KEEP_ALIVE_TIMEOUT_MS,
});

/** Default undici agent for all other origins (emotes, Cloudflare, id.twitch.tv, etc.). */
const defaultAgent = new Agent({ connectTimeout: Http.CONNECT_TIMEOUT_MS });

function resolveDispatcher(url: string): Dispatcher {
  const origin = new URL(url).origin;
  if (origin === 'https://gql.twitch.tv') return twitchGqlPool;
  if (origin === 'https://api.twitch.tv') return twitchApiPool;
  if (origin === 'https://usher.ttvnw.net') return twitchUsherPool;
  if (origin === 'https://discord.com') return discordPool;
  return defaultAgent;
}

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
  body: string | Buffer | Uint8Array | ReadableStream<Uint8Array> | null | undefined;
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

  return { body: body as string | Buffer | Uint8Array | ReadableStream<Uint8Array>, headers };
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
    timeoutMs = 15000,
    responseType,
    retryOptions,
    logContext = {},
    dispatcher,
  } = options ?? {};

  const urlStr = url.toString();
  const scrubbedUrl = scrubSensitiveParams(urlStr);

  const effectiveDispatcher = dispatcher ?? resolveDispatcher(urlStr);

  const actualResponseType = responseType ?? ('json' as R);
  const startTime = Date.now();

  const { body: preparedBody, headers: finalHeaders } = prepareBodyAndHeaders(body, customHeaders);
  const externalSignal = options?.signal;

  const defaultShouldRetry = (error: unknown, _attempt: number): boolean => {
    if (error instanceof HttpError) {
      const { statusCode } = error;
      if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
        return false;
      }
      return true;
    }

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return externalSignal == null || !externalSignal.aborted;
    }

    return false;
  };

  const shouldRetry = (error: unknown, attempt: number): boolean => {
    if (retryOptions?.shouldRetry) {
      return retryOptions.shouldRetry(error, attempt);
    }
    return defaultShouldRetry(error, attempt);
  };

  const retryAfterHeader = { value: 0 };

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
          undiciOpts.body = preparedBody;
        }
        undiciOpts.dispatcher = effectiveDispatcher;

        const response = await undiciRequest(urlStr, undiciOpts);

        if (response.statusCode === 429) {
          const rawHeader = response.headers['retry-after'];
          if (rawHeader != null && rawHeader !== '') {
            const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
            if (value != null && value !== '') {
              const parsed = parseInt(value, 10);
              if (!isNaN(parsed)) {
                retryAfterHeader.value = Math.max(parsed, 1);
              }
            }
          }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new HttpError(
            response.statusCode,
            `HTTP ${response.statusCode}: ${((response as unknown as Record<string, unknown>).statusMessage as string) ?? ''}`
          );
        }

        let parsedData: unknown;
        switch (actualResponseType) {
          case 'json': {
            const text = await response.body.text();
            parsedData = options?.parseReviver ? JSON.parse(text, options.parseReviver) : JSON.parse(text);
            break;
          }
          case 'text': {
            parsedData = await response.body.text();
            break;
          }
          case 'blob': {
            parsedData = new Blob([await response.body.arrayBuffer()]);
            break;
          }
          case 'arrayBuffer': {
            parsedData = await response.body.arrayBuffer();
            break;
          }
          case 'response': {
            return response;
          }
        }

        return parsedData as RequestResult<T, R>;
      },
      {
        attempts: retryOptions?.attempts ?? Http.DEFAULT_ATTEMPTS,
        baseDelayMs: retryOptions?.baseDelayMs ?? Http.DEFAULT_BASE_DELAY_MS,
        maxDelayMs: retryOptions?.maxDelayMs ?? Http.DEFAULT_MAX_DELAY_MS,
        shouldRetry,
        getDelayOverride: (_error, _attempt) => {
          if (retryAfterHeader.value > 0) {
            const override = retryAfterHeader.value * 1000;
            retryAfterHeader.value = 0;
            return override;
          }
          return null;
        },
      }
    );

    return result as RequestResult<T, R>;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
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
