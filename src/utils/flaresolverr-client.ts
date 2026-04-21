import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';
import { getFlareSolverrBaseUrl, getFlareSolverrSessionTtl } from '../config/env-accessors.js';
import { FLOARESOLVERR_TIMEOUT_MS } from '../constants.js';
import { sleep, getRetryDelay } from './delay.js';

const log = childLogger({ module: 'flaresolverr-client' });

export type FetchErrorCode =
  | 'NAVIGATION_TIMEOUT'
  | 'CAPTCHA_DETECTED'
  | 'INVALID_JSON_RESPONSE'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'MAX_RETRIES_EXCEEDED';

export interface FetchResult<T = unknown> {
  success: true;
  data: T;
  status: number;
}

export interface FetchError {
  success: false;
  error: string;
  code: FetchErrorCode;
}

export type FetchUrlResult<T> = FetchResult<T> | FetchError;

export interface FetchUrlOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

interface FlareSolverrResponse {
  solution: {
    status: number;
    headers?: Record<string, string>;
    cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
    response: string;
    userCurrentUrl?: string;
  };
  error?: string;
  message?: string;
}

export async function fetchUrl<T = unknown>(url: string, options?: FetchUrlOptions): Promise<FetchUrlResult<T>> {
  const baseURL = getFlareSolverrBaseUrl();
  const timeoutMs = options?.timeoutMs ?? FLOARESOLVERR_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const sessionTTL = getFlareSolverrSessionTtl();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${baseURL}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmd: 'request.get',
          url,
          maxTimeout: timeoutMs,
          session: 'kick-session',
          session_ttl_minutes: Math.ceil(sessionTTL / 60),
        }),
      });

      const body: FlareSolverrResponse = await response.json();

      if (body.error || body.message) {
        if (attempt === maxRetries) {
          return { success: false, error: body.error || body.message!, code: 'NETWORK_ERROR' };
        }
        continue;
      }

      const solution = body.solution;
      const status = solution.status;

      if (status >= 400) {
        if (attempt === maxRetries) {
          return { success: false, error: `HTTP ${status}`, code: 'HTTP_ERROR' };
        }
        continue;
      }

      const content = solution.response;

      let data: T;
      try {
        data = JSON.parse(content) as T;
      } catch {
        if (content.startsWith('{') || content.startsWith('[')) {
          try {
            data = JSON.parse(content) as T;
          } catch {
            return { success: false, error: 'Failed to parse response as JSON', code: 'INVALID_JSON_RESPONSE' };
          }
        } else {
          return { success: false, error: 'Response is not valid JSON (possible CAPTCHA)', code: 'CAPTCHA_DETECTED' };
        }
      }

      return { success: true, data, status };
    } catch (error) {
      const details = extractErrorDetails(error);
      if (attempt === maxRetries) {
        return { success: false, error: details.message, code: 'NETWORK_ERROR' };
      }
    }

    if (attempt < maxRetries) {
      const delayMs = getRetryDelay(attempt, 2000, 3, true);
      log.trace({ attempt, delayMs }, 'Applying backoff delay before next retry');
      await sleep(delayMs);
    }
  }

  return { success: false, error: 'MAX_RETRIES_EXCEEDED', code: 'MAX_RETRIES_EXCEEDED' };
}
