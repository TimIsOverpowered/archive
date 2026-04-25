import { extractErrorDetails } from './error.js';
import { childLogger } from './logger.js';
import { getBaseConfig } from '../config/env.js';
import { FLARESOLVERR_TIMEOUT_MS } from '../constants.js';
import { retryWithBackoff } from './retry.js';

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

async function fetchFromFlareSolverr(
  url: string,
  timeoutMs: number,
  sessionTTL: number
): Promise<FetchUrlResult<unknown>> {
  const baseURL = getBaseConfig().FLARESOLVERR_BASE_URL;

  const response = await fetch(`${baseURL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url,
      maxTimeout: timeoutMs,
      session: 'archive-session',
      session_ttl_minutes: Math.ceil(sessionTTL / 60),
    }),
  });

  const body: FlareSolverrResponse = await response.json();

  if (body.error || body.message) {
    throw new Error(body.error ?? body.message);
  }

  const solution = body.solution;
  const status = solution.status;

  if (status >= 400) {
    throw new Error(`HTTP ${status}`);
  }

  const content = solution.response;

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    if (content.startsWith('{') || content.startsWith('[')) {
      try {
        data = JSON.parse(content);
      } catch {
        throw new Error('Failed to parse response as JSON');
      }
    } else {
      throw new Error('Response is not valid JSON (possible CAPTCHA)');
    }
  }

  return { success: true, data, status };
}

export async function fetchUrl<T = unknown>(url: string, options?: FetchUrlOptions): Promise<FetchUrlResult<T>> {
  const timeoutMs = options?.timeoutMs ?? FLARESOLVERR_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const sessionTTL = getBaseConfig().FLARESOLVERR_SESSION_TTL;

  try {
    const result = await retryWithBackoff<FetchUrlResult<T>>(
      () => fetchFromFlareSolverr(url, timeoutMs, sessionTTL) as Promise<FetchUrlResult<T>>,
      { attempts: maxRetries + 1, baseDelayMs: 2000, maxDelayMs: 30_000 }
    );

    return result;
  } catch (error) {
    const details = extractErrorDetails(error);
    const message = details.message.toLowerCase();

    if (message.includes('json') || message.includes('captcha')) {
      return { success: false, error: details.message, code: 'INVALID_JSON_RESPONSE' };
    }

    if (message.startsWith('http')) {
      return { success: false, error: details.message, code: 'HTTP_ERROR' };
    }

    log.trace({ error: details.message }, 'FlareSolverr request failed');
    return { success: false, error: details.message, code: 'NETWORK_ERROR' };
  }
}
