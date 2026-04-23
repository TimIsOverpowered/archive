import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { TenantConfig } from '../config/types.js';
import { getBaseConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { extractDatabaseName } from '../utils/formatting.js';
import {
  DB_POOL_IDLE_TIMEOUT_MS,
  DB_POOL_MAX_CLIENTS,
  DB_POOL_CLEANUP_INTERVAL_MS,
  DB_STATEMENT_TIMEOUT_MS,
} from '../constants.js';
import { sleep } from '../utils/delay.js';
import type { StreamerDB } from './streamer-types.js';
import { buildPgBouncerUrl } from './utils/pg-bouncer.js';

interface PgPoolEntry {
  pool: InstanceType<typeof Pool>;
  db: Kysely<StreamerDB>;
  lastAccessedAt: number;
  createdAt: number;
}

class PoolManager {
  private pools = new Map<string, PgPoolEntry>();

  constructor(private readonly PoolCtor: typeof Pool = Pool) {}
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private creationLocks = new Map<string, Promise<Kysely<StreamerDB>>>();

  getClient(tenantId: string): Kysely<StreamerDB> | undefined {
    const entry = this.pools.get(tenantId);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      return entry.db;
    }
    return undefined;
  }

  async createClient(config: TenantConfig): Promise<Kysely<StreamerDB>> {
    const existing = this.pools.get(config.id);
    if (existing) return existing.db;

    const inflight = this.creationLocks.get(config.id);
    if (inflight) return inflight;

    if (this.pools.size >= DB_POOL_MAX_CLIENTS) {
      await this.evictOldestIdleClient();
    }

    const creationPromise = this.createConnection(config).finally(() => this.creationLocks.delete(config.id));
    this.creationLocks.set(config.id, creationPromise);
    return creationPromise;
  }

  private async createConnection(config: TenantConfig): Promise<Kysely<StreamerDB>> {
    const pgbouncerUrl = getBaseConfig().PGBOUNCER_URL;
    const connectionLimit = config.database.connectionLimit ?? 2;
    const tenantDbName = extractDatabaseName(config.database.url);

    const url = buildPgBouncerUrl(pgbouncerUrl, tenantDbName);

    const pool = new this.PoolCtor({
      connectionString: url,
      max: connectionLimit,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    });
    const db = new Kysely<StreamerDB>({ dialect: new PostgresDialect({ pool }) });

    this.pools.set(config.id, {
      pool,
      db,
      lastAccessedAt: Date.now(),
      createdAt: Date.now(),
    });

    return db;
  }

  async closeClient(tenantId: string): Promise<void> {
    const entry = this.pools.get(tenantId);
    if (entry) {
      try {
        await entry.pool.end();
      } catch (error) {
        getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect DB pool');
      }
      this.pools.delete(tenantId);
    }
  }

  async evictOldestIdleClient(): Promise<void> {
    const entries = Array.from(this.pools.entries()).sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    for (const [tenantId, entry] of entries) {
      if (entry.pool.idleCount === entry.pool.totalCount) {
        await this.closeClient(tenantId);
        getLogger().info({ tenantId }, 'Evicted oldest idle client due to MAX_CLIENTS limit');
        return;
      }
    }
  }

  async evictIdleClients(): Promise<void> {
    const now = Date.now();
    const cutoff = now - DB_POOL_IDLE_TIMEOUT_MS;

    for (const [tenantId, entry] of this.pools.entries()) {
      const isFullyIdle = entry.pool.idleCount === entry.pool.totalCount;
      if (entry.lastAccessedAt < cutoff && isFullyIdle) {
        const idleDuration = now - entry.lastAccessedAt;

        try {
          await entry.pool.end();
        } catch (error) {
          getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during eviction');
        }

        this.pools.delete(tenantId);

        getLogger().info(
          { tenantId, idleDurationMs: idleDuration, activePools: this.pools.size },
          'DB pool evicted (idle timeout)'
        );
      }
    }
  }

  startCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      return;
    }

    this.cleanupIntervalId = setInterval(() => {
      this.evictIdleClients().catch((error) => {
        getLogger().error({ error: extractErrorDetails(error) }, 'Error during idle pool eviction');
      });
    }, DB_POOL_CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  reset(): void {
    this.stopCleanup();
    this.pools.clear();
    this.creationLocks.clear();
  }

  getCount(): number {
    return this.pools.size;
  }

  isPoolValid(tenantId: string): boolean {
    const entry = this.pools.get(tenantId);
    if (!entry) return false;
    return Date.now() - entry.lastAccessedAt <= DB_POOL_IDLE_TIMEOUT_MS;
  }

  touchPool(tenantId: string): boolean {
    const entry = this.pools.get(tenantId);
    if (entry) {
      entry.lastAccessedAt = Date.now();
    }
    return !!entry;
  }

  async closeAll(): Promise<void> {
    this.stopCleanup();

    for (const [tenantId, entry] of this.pools.entries()) {
      const isFullyIdle = entry.pool.idleCount === entry.pool.totalCount;
      if (!isFullyIdle) {
        getLogger().info(
          { tenantId, active: entry.pool.totalCount - entry.pool.idleCount },
          'Skipping pool shutdown (active connections)'
        );
        continue;
      }
      try {
        await entry.pool.end();
      } catch (error) {
        getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during shutdown');
      }
    }

    this.pools.clear();
    this.creationLocks.clear();
  }
}

const poolManager = new PoolManager();

export { poolManager };

export function createPoolManager(PoolCtor: typeof Pool = Pool): PoolManager {
  return new PoolManager(PoolCtor);
}

export function getClient(tenantId: string): Kysely<StreamerDB> | undefined {
  return poolManager.getClient(tenantId);
}

export async function createClient(config: TenantConfig): Promise<Kysely<StreamerDB>> {
  return poolManager.createClient(config);
}

export async function closeClient(tenantId: string): Promise<void> {
  return poolManager.closeClient(tenantId);
}

export async function closeAllClients(): Promise<void> {
  return poolManager.closeAll();
}

export function startClientCleanup(): void {
  poolManager.startCleanup();
}

export function stopClientCleanup(): void {
  poolManager.stopCleanup();
}

export function getClientCount(): number {
  return poolManager.getCount();
}

export function resetClientManager(): void {
  poolManager.reset();
}

/**
 * Check if pool is still valid (not evicted due to idle timeout)
 */
export function isClientValid(tenantId: string): boolean {
  return poolManager.isPoolValid(tenantId);
}

/**
 * Touch pool to prevent eviction during long-running operations
 */
export function touchClient(tenantId: string): boolean {
  return poolManager.touchPool(tenantId);
}

const PG_CONNECTION_ERROR_CODES = new Set(['57P01', '08006', '08007', '08001']);
const NODE_CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

/**
 * Detect connection errors from PostgreSQL and Node.js
 */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  if (code && (PG_CONNECTION_ERROR_CODES.has(code) || NODE_CONNECTION_ERROR_CODES.has(code))) {
    return true;
  }

  if (!(error instanceof Error)) return false;

  const msg = error.message;
  const connPatterns = [
    /connection (terminated|lost|closed)/i,
    /socket (connection closed|closed by|network socket closed)/i,
    /client network socket closed/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /The socket has been closed/i,
  ];

  return connPatterns.some((pattern) => pattern.test(msg));
}

/**
 * Ensure pool is valid, recreate if evicted or invalid
 */
export async function ensureClient(tenantId: string, config: TenantConfig): Promise<Kysely<StreamerDB>> {
  let client = getClient(tenantId);

  if (!client || !isClientValid(tenantId)) {
    client = await createClient(config);
  } else {
    touchClient(tenantId);
  }

  return client;
}

/**
 * Wrap DB operation with automatic retry on connection failure
 */
export async function withDbRetry<T>(
  tenantId: string,
  config: TenantConfig,
  operation: (db: Kysely<StreamerDB>) => Promise<T>,
  options: { maxRetries?: number; retryDelayMs?: number } = {}
): Promise<T> {
  const { maxRetries = 2, retryDelayMs = 1000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const client = await ensureClient(tenantId, config);
      return await operation(client);
    } catch (error) {
      const isConnError = isConnectionError(error);

      if (!isConnError) {
        throw error;
      }

      if (attempt === maxRetries) {
        getLogger().error(
          { tenantId, attempt, error: extractErrorDetails(error) },
          'DB operation failed after max retries'
        );
        throw error;
      }

      getLogger().error({ tenantId, attempt, error: extractErrorDetails(error) }, 'DB connection error, retrying...');

      await closeClient(tenantId).catch((err) => {
        getLogger().debug({ tenantId, error: extractErrorDetails(err) }, 'Failed to close invalid client');
      });

      await sleep(retryDelayMs);
    }
  }

  throw new Error('Unreachable: DB operation failed');
}
