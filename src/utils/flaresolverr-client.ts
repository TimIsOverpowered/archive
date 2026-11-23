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
  data?: { session?: string; sessions?: string[] };
  session?: string;
  sessions?: string[];
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

// ── Session lifecycle ────────────────────────────────────────────────────────
//
// Session IDs are deterministic (`archive-<pool>-<index>`) and FlareSolverr's
// `sessions.create` is idempotent, so a still-warm session (challenge already
// solved) is reused across app restarts instead of launching a fresh browser
// every time.

interface CreatedSession {
  id: string;
  fresh: boolean;
}

function sanitizeSessionIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function createFlareSolverrSession(sessionId: string): Promise<CreatedSession> {
  const result = await callFlareSolverr({ cmd: 'sessions.create', session: sessionId });
  if (result.status === 'error' || result.error != null) {
    throw new Error(result.error ?? result.message ?? `Failed to create FlareSolverr session ${sessionId}`);
  }
  const id = result.session ?? result.data?.session;
  if (id == null) {
    throw new Error('No session ID returned from FlareSolverr');
  }
  return { id, fresh: result.message !== 'Session already exists.' };
}

async function destroyFlareSolverrSession(sessionId: string): Promise<void> {
  try {
    await callFlareSolverr({ cmd: 'sessions.destroy', session: sessionId });
  } catch {
    // Best-effort — session may already be expired
  }
}

async function listFlareSolverrSessions(): Promise<string[]> {
  const result = await callFlareSolverr({ cmd: 'sessions.list' });
  const sessions = result.sessions ?? result.data?.sessions ?? [];
  return sessions.filter((id): id is string => typeof id === 'string');
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

// ── Session Pool ─────────────────────────────────────────────────────────────

interface SessionPoolConfig {
  size: number;
  name: string;
}

/** Used when pool initialization fails; FlareSolverr creates it on demand, so init can be retried. */
const FALLBACK_SESSION_ID = `${Flaresolverr.SESSION_ID_PREFIX}-fallback`;

class SessionPool {
  private sessions: string[] = [];
  private index = 0;
  private initPromise: Promise<void> | null = null;

  /** Deterministic FlareSolverr session IDs owned by this pool. */
  readonly ownedSessionIds: string[];

  constructor(private config: SessionPoolConfig) {
    const prefix = `${Flaresolverr.SESSION_ID_PREFIX}-${sanitizeSessionIdSegment(config.name)}`;
    this.ownedSessionIds = Array.from({ length: config.size }, (_, i) => `${prefix}-${i}`);
  }

  /**
   * Creates (or reuses) the pool's sessions. Concurrent callers await the same
   * promise; if nothing could be created (e.g. FlareSolverr is down) the pool
   * is not marked initialized, so the next call retries.
   */
  ensureInitialized(): Promise<void> {
    if (this.initPromise == null) {
      this.initPromise = this.initialize().finally(() => {
        if (this.sessions.length === 0) {
          this.initPromise = null;
        }
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const startedAt = Date.now();
    const results = await Promise.allSettled(this.ownedSessionIds.map((id) => createFlareSolverrSession(id)));

    const created: CreatedSession[] = [];
    const errors: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        created.push(result.value);
      } else {
        errors.push(extractErrorDetails(result.reason).message);
      }
    }

    this.sessions = created.map((session) => session.id);
    const reused = created.filter((session) => !session.fresh).length;

    if (created.length === 0) {
      log.error({ pool: this.config.name, errors }, 'Failed to initialize session pool (will retry on next use)');
      return;
    }

    log.info(
      {
        pool: this.config.name,
        count: created.length,
        newSessions: created.length - reused,
        reusedSessions: reused,
        durationMs: Date.now() - startedAt,
      },
      'Session pool initialized'
    );
  }

  async getSession(): Promise<string> {
    await this.ensureInitialized();
    if (this.sessions.length === 0) {
      return FALLBACK_SESSION_ID;
    }
    const session = this.sessions[this.index % this.sessions.length];
    this.index++;
    if (session == null) {
      throw new Error('Session pool has no sessions');
    }
    return session;
  }

  /**
   * Replaces a flagged session. The old session is destroyed *before* its
   * deterministic ID is re-created so FlareSolverr launches a fresh browser.
   */
  async replaceSession(failedSession: string): Promise<string> {
    await destroyFlareSolverrSession(failedSession);
    const { id } = await createFlareSolverrSession(failedSession);
    log.info({ pool: this.config.name, sessionId: id }, 'Replaced flagged session');
    return id;
  }

  /** Destroys every owned session (used on shutdown so browsers are not leaked). */
  async destroyAll(): Promise<void> {
    const ids = [...new Set([...this.sessions, ...this.ownedSessionIds])];
    if (ids.length === 0) return;

    await Promise.allSettled(ids.map((id) => destroyFlareSolverrSession(id)));
    this.sessions = [];
    this.index = 0;
    this.initPromise = null;
    log.info({ pool: this.config.name, count: ids.length }, 'Session pool destroyed');
  }
}

// ── Per-Tenant Session Pool ──────────────────────────────────────────────────

const tenantPools = new Map<string, SessionPool>();

function getOrCreateTenantPool(tenantId: string): SessionPool {
  const existing = tenantPools.get(tenantId);
  if (existing != null) return existing;

  const pool = new SessionPool({ size: Flaresolverr.SESSION_POOL_SIZE, name: `tenant:${tenantId}` });
  tenantPools.set(tenantId, pool);
  return pool;
}

// ── Shared Pool ──────────────────────────────────────────────────────────────

const sharedPool = new SessionPool({ size: Flaresolverr.SESSION_POOL_SIZE, name: 'shared' });

// ── Startup / Shutdown ───────────────────────────────────────────────────────

/**
 * Pre-warms the shared pool and (optionally) per-tenant pools after a restart.
 * Pools initialize *sequentially* (their sessions in parallel within a pool),
 * so a restart with N tenants does not launch N×3 headless browsers at once.
 * Callers that need a session while a pool is initializing await the same
 * promise, so this can be fired and forgotten at startup.
 */
export async function prewarmFlaresolverrPools(tenantSessionIds: string[] = []): Promise<void> {
  const pools = [sharedPool, ...tenantSessionIds.map((id) => getOrCreateTenantPool(id))];
  const expected = new Set(pools.flatMap((pool) => pool.ownedSessionIds));

  await sweepStaleSessions(expected, tenantSessionIds.length > 0);

  for (const pool of pools) {
    await pool.ensureInitialized();
  }
}

/**
 * Destroys owned-but-unused sessions (e.g. tenants removed from the config).
 * Only touches the pool families this process pre-warms, so it never destroys
 * another process's tenant pools.
 */
async function sweepStaleSessions(expected: Set<string>, includeTenantFamilies: boolean): Promise<void> {
  try {
    const families = [`${Flaresolverr.SESSION_ID_PREFIX}-shared`];
    if (includeTenantFamilies) {
      families.push(`${Flaresolverr.SESSION_ID_PREFIX}-tenant`);
    }

    const active = await listFlareSolverrSessions();
    const stale = active.filter((id) => families.some((family) => id.startsWith(family)) && !expected.has(id));
    if (stale.length === 0) return;

    await Promise.allSettled(stale.map((id) => destroyFlareSolverrSession(id)));
    log.info({ count: stale.length, stale }, 'Destroyed stale FlareSolverr sessions');
  } catch (error) {
    const details = extractErrorDetails(error);
    log.warn({ ...details }, 'Failed to sweep stale FlareSolverr sessions');
  }
}

/** Destroys all pooled sessions (called on graceful shutdown). */
export async function shutdownFlaresolverrPools(): Promise<void> {
  const pools: SessionPool[] = [sharedPool, ...tenantPools.values()];
  await Promise.allSettled(pools.map((pool) => pool.destroyAll()));
  tenantPools.clear();
}

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
