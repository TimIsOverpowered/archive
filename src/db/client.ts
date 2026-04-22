import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { TenantConfig } from '../config/types.js';
import { getBaseConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { extractDatabaseName } from '../utils/formatting.js';
import { DB_POOL_IDLE_TIMEOUT_MS, DB_POOL_MAX_CLIENTS, DB_POOL_CLEANUP_INTERVAL_MS } from '../constants.js';
import { sleep } from '../utils/delay.js';
import type { StreamerDB } from './streamer-types.js';

let PoolCtor: typeof Pool = Pool;

export function _setPoolCtor(ctor: typeof Pool): void {
  PoolCtor = ctor;
}

interface PgPoolEntry {
  pool: Pool;
  db: Kysely<StreamerDB>;
  lastAccessedAt: number;
  createdAt: number;
}

class PoolManager {
  private pools = new Map<string, PgPoolEntry>();
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

    const creationPromise = this._doCreate(config).finally(() => this.creationLocks.delete(config.id));
    this.creationLocks.set(config.id, creationPromise);
    return creationPromise;
  }

  private async _doCreate(config: TenantConfig): Promise<Kysely<StreamerDB>> {
    const pgbouncerUrl = getBaseConfig().PGBOUNCER_URL;
    const connectionLimit = config.database.connectionLimit ?? 2;
    const tenantDbName = extractDatabaseName(config.database.url);

    const url = new URL(pgbouncerUrl);
    url.pathname = `/${tenantDbName}`;

    const pool = new PoolCtor({ connectionString: url.toString(), max: connectionLimit });
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
    let oldestTenantId: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [tenantId, entry] of this.pools.entries()) {
      if (entry.lastAccessedAt < oldestTimestamp) {
        oldestTimestamp = entry.lastAccessedAt;
        oldestTenantId = tenantId;
      }
    }

    if (oldestTenantId) {
      await this.closeClient(oldestTenantId);
      getLogger().info({ tenantId: oldestTenantId }, 'Evicted oldest idle client due to MAX_CLIENTS limit');
    }
  }

  async evictIdleClients(): Promise<void> {
    const now = Date.now();
    const cutoff = now - DB_POOL_IDLE_TIMEOUT_MS;

    for (const [tenantId, entry] of this.pools.entries()) {
      if (entry.lastAccessedAt < cutoff) {
        const idleDuration = now - entry.lastAccessedAt;

        try {
          await entry.pool.end();
        } catch (error) {
          getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during eviction');
        }

        this.pools.delete(tenantId);

        getLogger().info(
          { tenantId, idleDuration, totalPools: this.pools.size },
          `[DB Pool Manager] Evicted idle pool for tenant: ${tenantId}. Idle for: ${idleDuration}ms. Active pools remaining: ${this.pools.size}`
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
    if (entry) entry.lastAccessedAt = Date.now();
    return !!entry;
  }

  async closeAll(): Promise<void> {
    this.stopCleanup();

    for (const [tenantId, entry] of this.pools.entries()) {
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

/**
 * Detect connection errors from PostgreSQL
 */
export function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;

  if (code) {
    return ['57P01', '08006', '08007', '08001', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code);
  }

  return (
    msg.includes('terminated unexpectedly') ||
    msg.includes('connection closed') ||
    msg.includes('connection lost') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('The socket has been closed') ||
    msg.includes('client network socket closed')
  );
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
