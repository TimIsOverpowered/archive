import * as cheerio from 'cheerio';
import { getBaseConfig } from '../config/env.ts';
import { Flaresolverr } from '../constants.ts';
import { extractErrorDetails } from './error.ts';
import { childLogger } from './logger.ts';

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
  cookies?: string;
  userAgent?: string;
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
  sessionId?: string | null | undefined;
}

interface FlareSolverrResponse {
  status: string;
  message?: string;
  error?: string;
  solution?: {
    status: number;
    headers?: Record<string, string>;
    cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
    response: string;
    userAgent?: string;
    userCurrentUrl?: string;
  };
}

interface FlareSolverrSessionResponse {
  status: string;
  message?: string;
  error?: string;
  data?: { session?: string };
  session?: string;
}

async function callFlareSolverr(body: Record<string, unknown>): Promise<FlareSolverrSessionResponse> {
  const baseURL = getBaseConfig().FLARESOLVERR_BASE_URL;
  const response = await fetch(`${baseURL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as FlareSolverrSessionResponse;
}

async function createFlareSolverrSession(): Promise<string> {
  const result = await callFlareSolverr({ cmd: 'sessions.create' });
  if (result.status === 'error' || result.error != null) {
    throw new Error(result.error ?? result.message ?? 'Failed to create FlareSolverr session');
  }
  const sessionId = result.session ?? result.data?.session;
  if (sessionId == null) {
    throw new Error('No session ID returned from FlareSolverr');
  }
  return sessionId;
}

async function destroyFlareSolverrSession(sessionId: string): Promise<void> {
  try {
    await callFlareSolverr({ cmd: 'sessions.destroy', session: sessionId });
  } catch {
    // Best-effort — session may already be expired
  }
}

async function fetchFromFlareSolverr(
  url: string,
  timeoutMs: number,
  sessionTTL: number,
  sessionId: string
): Promise<FetchUrlResult<unknown>> {
  const baseURL = getBaseConfig().FLARESOLVERR_BASE_URL;

  const response = await fetch(`${baseURL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url,
      maxTimeout: timeoutMs,
      session: sessionId,
      session_ttl_minutes: Math.ceil(sessionTTL / 60),
    }),
  });

  const body = (await response.json()) as FlareSolverrResponse;

  if (body.status === 'error' || body.error != null) {
    throw new Error(body.error ?? body.message ?? 'Unknown FlareSolverr error');
  }

  const solution = body.solution;
  if (!solution) {
    throw new Error(body.message ?? 'Missing FlareSolverr solution');
  }

  const status = solution.status;

  if (status >= 400) {
    throw new Error(`HTTP ${status}`);
  }

  const content = solution.response;

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    const $ = cheerio.load(content);
    const cleanText = $('pre').text() !== '' ? $('pre').text() : $('body').text() !== '' ? $('body').text() : '';

    try {
      data = JSON.parse(cleanText);
    } catch {
      throw new Error('Response is not valid JSON (possible CAPTCHA)');
    }
  }

  const cookieString = solution.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    success: true,
    data,
    status,
    cookies: cookieString,
    ...(solution.userAgent != null && { userAgent: solution.userAgent }),
  };
}

// ── Shared Session Pool ──────────────────────────────────────────────────────

interface SessionPoolConfig {
  size: number;
  name: string;
}

class SessionPool {
  private sessions: string[] = [];
  private index = 0;
  private initialized = false;
  private initializing = false;

  constructor(private config: SessionPoolConfig) {}

  async ensureInitialized(): Promise<void> {
    if (this.initialized || this.initializing) return;
    this.initializing = true;

    try {
      const sessionCount = this.config.size;
      const results = await Promise.all(Array.from({ length: sessionCount }, () => createFlareSolverrSession()));
      this.sessions = results;
      this.initialized = true;
      log.info({ pool: this.config.name, count: sessionCount }, 'Session pool initialized');
    } catch (error) {
      const details = extractErrorDetails(error);
      log.error({ pool: this.config.name, ...details }, 'Failed to initialize session pool');
      this.sessions = ['archive-session'];
      this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  async getSession(): Promise<string> {
    await this.ensureInitialized();
    const session = this.sessions[this.index % this.sessions.length];
    this.index++;
    if (session == null) {
      throw new Error('Session pool has no sessions');
    }
    return session;
  }

  async replaceSession(failedSession: string): Promise<string> {
    const newSession = await createFlareSolverrSession();
    const idx = this.sessions.indexOf(failedSession);
    if (idx !== -1) {
      await destroyFlareSolverrSession(failedSession);
      this.sessions[idx] = newSession;
    }
    log.info({ pool: this.config.name, oldSession: failedSession, newSession }, 'Replaced flagged session');
    return newSession;
  }
}

// ── Per-Tenant Session Pool ──────────────────────────────────────────────────

const tenantPools = new Map<string, SessionPool>();

function getOrCreateTenantPool(tenantId: string): SessionPool {
  const existing = tenantPools.get(tenantId);
  if (existing) return existing;

  let pool = tenantPools.get(tenantId);
  if (pool) return pool;

  pool = new SessionPool({ size: 3, name: `tenant:${tenantId}` });
  tenantPools.set(tenantId, pool);
  return pool;
}

// ── Shared Pool ──────────────────────────────────────────────────────────────

const sharedPool = new SessionPool({ size: 3, name: 'shared' });

// ── fetchUrl ─────────────────────────────────────────────────────────────────

export async function fetchUrl<T = unknown>(url: string, options?: FetchUrlOptions): Promise<FetchUrlResult<T>> {
  const timeoutMs = options?.timeoutMs ?? Flaresolverr.TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 3;
  const sessionTTL = getBaseConfig().FLARESOLVERR_SESSION_TTL;

  let sessionId: string | undefined;

  if (options?.sessionId != null) {
    // Per-tenant session — use dedicated pool for rotation
    const pool = getOrCreateTenantPool(options.sessionId);
    sessionId = await pool.getSession();
  } else {
    // Shared pool for callers that don't specify a session
    sessionId = await sharedPool.getSession();
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = (await fetchFromFlareSolverr(url, timeoutMs, sessionTTL, sessionId)) as FetchUrlResult<T>;

      if (result.success) {
        return result;
      }

      lastError = new Error(result.error);
      return result;
    } catch (error) {
      const details = extractErrorDetails(error);
      const message = details.message.toLowerCase();

      const isTimeout = message.includes('timeout');
      const isCaptcha = message.includes('captcha');
      const isFlagged = message.includes('captcha') || message.includes('cloudflare') || message.includes('challenge');

      if (isTimeout || isCaptcha || isFlagged) {
        // Destroy the flagged session and get a fresh one
        const pool = options?.sessionId != null ? getOrCreateTenantPool(options.sessionId) : sharedPool;

        const newSessionId = await pool.replaceSession(sessionId);
        sessionId = newSessionId;
        lastError = error;

        if (attempt >= maxRetries) {
          break;
        }
        continue;
      }

      lastError = error;
      break;
    }
  }

  // All retries exhausted — classify the final error
  const finalMessage = extractErrorDetails(lastError).message.toLowerCase();

  if (finalMessage.includes('timeout')) {
    return { success: false, error: extractErrorDetails(lastError).message, code: 'NAVIGATION_TIMEOUT' };
  }

  if (finalMessage.includes('captcha')) {
    return { success: false, error: extractErrorDetails(lastError).message, code: 'CAPTCHA_DETECTED' };
  }

  if (finalMessage.includes('json')) {
    return { success: false, error: extractErrorDetails(lastError).message, code: 'INVALID_JSON_RESPONSE' };
  }

  if (finalMessage.startsWith('http')) {
    return { success: false, error: extractErrorDetails(lastError).message, code: 'HTTP_ERROR' };
  }

  log.trace({ error: extractErrorDetails(lastError).message }, 'FlareSolverr request failed');
  return { success: false, error: extractErrorDetails(lastError).message, code: 'NETWORK_ERROR' };
}
