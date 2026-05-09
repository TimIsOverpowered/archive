import { Kysely, PostgresDialect, SafeNullComparisonPlugin } from 'kysely';
import { Pool } from 'pg';
import { getBaseConfig } from '../config/env.js';
import { TenantConfig } from '../config/types.js';
import { Db } from '../constants.js';
import { sleep } from '../utils/delay.js';
import { extractErrorDetails } from '../utils/error.js';
import { getLogger } from '../utils/logger.js';
import type { StreamerDB } from './streamer-types.js';
import { isConnectionError } from './utils/errors.js';
import { buildPgBouncerUrl } from './utils/pg-bouncer.js';

interface PgPoolEntry {
  pool: InstanceType<typeof Pool>;
  db: Kysely<StreamerDB>;
  lastAccessedAt: number;
  createdAt: number;
}

class PoolManager {
  private pools = new Map<string, PgPoolEntry>();
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private creationLocks = new Map<string, Promise<Kysely<StreamerDB>>>();

  constructor(private readonly PoolCtor: typeof Pool = Pool) {}

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

    const totalConns = this.pools.size * Db.POOL_MAX_PER_TENANT;
    if (totalConns >= Db.POOL_GLOBAL_MAX_CONNECTIONS) {
      const evicted = await this.evictOldestIdleClient();
      if (!evicted) {
        throw new Error('Global connection limit reached. System under heavy load.');
      }
    }

    const creationPromise = Promise.resolve(this.createConnection(config)).finally(() =>
      this.creationLocks.delete(config.id)
    );
    this.creationLocks.set(config.id, creationPromise);
    return creationPromise;
  }

  private buildConnection(config: TenantConfig): PgPoolEntry {
    const pgbouncerUrl = getBaseConfig().PGBOUNCER_URL;
    const url = buildPgBouncerUrl(pgbouncerUrl, config.database.name);

    const pool = new this.PoolCtor({
      connectionString: url,
      max: Db.POOL_MAX_PER_TENANT,
      query_timeout: Db.QUERY_TIMEOUT_MS,
    });
    const db = new Kysely<StreamerDB>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new SafeNullComparisonPlugin()],
    });

    return { pool, db, lastAccessedAt: Date.now(), createdAt: Date.now() };
  }

  private registerConnection(tenantId: string, entry: PgPoolEntry): void {
    this.pools.set(tenantId, entry);
  }

  private createConnection(config: TenantConfig): Kysely<StreamerDB> {
    const entry = this.buildConnection(config);
    this.registerConnection(config.id, entry);
    return entry.db;
  }

  async closeClient(tenantId: string): Promise<void> {
    const entry = this.pools.get(tenantId);
    if (entry) {
      try {
        await entry.db.destroy();
      } catch (error) {
        getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect DB pool');
      }
      this.pools.delete(tenantId);
    }
  }

  async evictOldestIdleClient(): Promise<boolean> {
    const entries = Array.from(this.pools.entries()).sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    for (const [tenantId, entry] of entries) {
      if (entry.pool.idleCount === entry.pool.totalCount) {
        await this.closeClient(tenantId);
        getLogger().info({ tenantId }, 'Evicted oldest idle client due to MAX_CLIENTS limit');
        return true;
      }
    }
    return false;
  }

  async evictIdleClients(): Promise<void> {
    const now = Date.now();
    const cutoff = now - Db.POOL_IDLE_TIMEOUT_MS;

    for (const [tenantId, entry] of this.pools.entries()) {
      const isFullyIdle = entry.pool.idleCount === entry.pool.totalCount;
      if (entry.lastAccessedAt < cutoff && isFullyIdle) {
        const idleDuration = now - entry.lastAccessedAt;

        try {
          await entry.db.destroy();
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
    }, Db.POOL_CLEANUP_INTERVAL_MS);
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
    return Date.now() - entry.lastAccessedAt <= Db.POOL_IDLE_TIMEOUT_MS;
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

    const shutdownPromises = Array.from(this.pools.entries()).map(async ([tenantId, entry]) => {
      try {
        await entry.db.destroy();
      } catch (error) {
        getLogger().warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during shutdown');
      }
    });

    await Promise.all(shutdownPromises);

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
