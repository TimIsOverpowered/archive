import { PrismaClient } from '../../generated/streamer/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { TenantConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import {
  PRISMA_MODELS_TO_INVALIDATE,
  DB_CLIENT_IDLE_TIMEOUT_MS,
  DB_CLIENT_MAX_CLIENTS,
  DB_CLIENT_CLEANUP_INTERVAL_MS,
} from '../constants.js';
import { invalidateVodCache, invalidateTenantVodListCache, invalidateEmoteCache } from '../services/vod-cache.js';
import { sleep } from '../utils/delay.js';

function extractVodIdsFromWhere(where: Record<string, unknown> | undefined): number[] {
  if (!where || typeof where !== 'object') return [];
  const idClause = where.vod_id ?? where.id;
  if (idClause === null || idClause === undefined) return [];
  if (typeof idClause === 'object' && 'in' in idClause) {
    const arr = (idClause as { in: unknown[] }).in;
    return Array.isArray(arr) ? arr.map((id) => Number(id)).filter((id) => !isNaN(id)) : [];
  }
  if (typeof idClause !== 'object') {
    const numId = Number(idClause);
    return !isNaN(numId) ? [numId] : [];
  }
  return [];
}

function extractVodIdsFromData(data: unknown[]): number[] {
  return data
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && 'vod_id' in item)
    .map((item) => Number((item as { vod_id: unknown }).vod_id))
    .filter((id) => !isNaN(id));
}

function invalidateVodIds(tenantId: string, ids: number[]): void {
  for (const id of ids) {
    invalidateVodCache(tenantId, id).catch((error) => {
      logger.warn({ tenantId, vodId: id, error: extractErrorDetails(error) }, 'Cache invalidation failed');
    });
    logger.debug({ tenantId, vodId: id }, 'VOD cache invalidated via extension');
  }
}

const cacheInvalidationExtension = (tenantId: string, baseClient: PrismaClient) =>
  baseClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const mutations = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'];
          if (
            !mutations.includes(operation) ||
            !PRISMA_MODELS_TO_INVALIDATE.includes(model as (typeof PRISMA_MODELS_TO_INVALIDATE)[number])
          ) {
            return query(args);
          }

          try {
            const result = await query(args);
            const affectedVodIds: number[] = [];

            if (model === 'Vod') {
              if (operation === 'create') {
                if (result && typeof result === 'object' && 'id' in result) {
                  const numId = Number((result as { id: unknown }).id);
                  if (!isNaN(numId)) affectedVodIds.push(numId);
                }
              } else if (operation === 'createMany') {
                const data = (args as { data?: unknown[] }).data ?? [];
                const ids = data
                  .filter(
                    (item): item is Record<string, unknown> => item != null && typeof item === 'object' && 'id' in item
                  )
                  .map((item) => Number((item as { id: unknown }).id))
                  .filter((id) => !isNaN(id));
                if (ids.length === 0 && data.length > 0) {
                  logger.debug(
                    { tenantId, recordCount: data.length },
                    'Vod.createMany called without explicit IDs — tenant list cache will be invalidated instead'
                  );
                }
                affectedVodIds.push(...ids);
              } else {
                affectedVodIds.push(...extractVodIdsFromWhere((args as { where?: Record<string, unknown> }).where));
              }
            } else if (model === 'Emote') {
              const whereIds = extractVodIdsFromWhere((args as { where?: Record<string, unknown> }).where);
              if (operation === 'create') {
                const data = (args as { data?: Record<string, unknown> }).data;
                if (data && 'vod_id' in data) {
                  const numId = Number((data as { vod_id: unknown }).vod_id);
                  if (!isNaN(numId)) whereIds.push(numId);
                }
              }
              for (const id of whereIds) {
                invalidateEmoteCache(tenantId, id).catch((error) => {
                  logger.warn(
                    { tenantId, vodId: id, error: extractErrorDetails(error) },
                    'Emote cache invalidation failed'
                  );
                });
              }
            } else {
              if (operation === 'create') {
                const data = (args as { data?: Record<string, unknown> }).data;
                if (data && 'vod_id' in data) {
                  const numId = Number((data as { vod_id: unknown }).vod_id);
                  if (!isNaN(numId)) affectedVodIds.push(numId);
                }
              } else if (operation === 'createMany') {
                const data = (args as { data?: unknown[] }).data ?? [];
                affectedVodIds.push(...extractVodIdsFromData(data));
              } else {
                affectedVodIds.push(...extractVodIdsFromWhere((args as { where?: Record<string, unknown> }).where));
              }
            }

            const uniqueIds = [...new Set(affectedVodIds)];
            invalidateVodIds(tenantId, uniqueIds);
            await invalidateTenantVodListCache(tenantId).catch((error) => {
              logger.warn({ tenantId, error: extractErrorDetails(error) }, 'Tenant list cache invalidation failed');
            });

            return result;
          } catch (error) {
            throw error;
          }
        },
      },
    },
  });

interface ClientEntry {
  client: PrismaClient;
  lastAccessedAt: number;
  createdAt: number;
}

class ClientManager {
  private clients = new Map<string, ClientEntry>();
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private creationLocks = new Map<string, Promise<PrismaClient>>();

  getClient(tenantId: string): PrismaClient | undefined {
    const entry = this.clients.get(tenantId);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      return entry.client;
    }
    return undefined;
  }

  async createClient(config: TenantConfig): Promise<PrismaClient> {
    if (this.clients.has(config.id)) {
      return this.clients.get(config.id)!.client;
    }

    if (this.creationLocks.has(config.id)) {
      await this.creationLocks.get(config.id)!;
      return this.clients.get(config.id)!.client;
    }

    if (this.clients.size >= DB_CLIENT_MAX_CLIENTS) {
      await this.evictOldestIdleClient();
    }

    const creationPromise = (async (): Promise<PrismaClient> => {
      let extendedClient: PrismaClient;
      try {
        const connectionLimit = config.database.connectionLimit || 5;
        const urlWithParams = `${config.database.url}${config.database.url.includes('?') ? '&' : '?'}connection_limit=${connectionLimit}`;
        const adapter = new PrismaPg({ connectionString: urlWithParams });

        // Create base client
        const baseClient = new PrismaClient({ adapter });
        await baseClient.$connect();

        // Extend with cache invalidation - THIS IS THE CLIENT WE STORE
        extendedClient = cacheInvalidationExtension(config.id, baseClient) as unknown as PrismaClient;

        this.clients.set(config.id, {
          client: extendedClient, // Store the extended client, not baseClient
          lastAccessedAt: Date.now(),
          createdAt: Date.now(),
        });

        return extendedClient; // Return the extended client
      } finally {
        this.creationLocks.delete(config.id);
      }
    })();

    this.creationLocks.set(config.id, creationPromise);
    return creationPromise;
  }

  async closeClient(tenantId: string): Promise<void> {
    const entry = this.clients.get(tenantId);
    if (entry) {
      try {
        await entry.client.$disconnect();
      } catch (error) {
        logger.warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect DB client');
      }
      this.clients.delete(tenantId);
    }
  }

  async evictOldestIdleClient(): Promise<void> {
    let oldestTenantId: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [tenantId, entry] of this.clients.entries()) {
      if (entry.lastAccessedAt < oldestTimestamp) {
        oldestTimestamp = entry.lastAccessedAt;
        oldestTenantId = tenantId;
      }
    }

    if (oldestTenantId) {
      await this.closeClient(oldestTenantId);
      logger.info({ tenantId: oldestTenantId }, 'Evicted oldest idle client due to MAX_CLIENTS limit');
    }
  }

  async evictIdleClients(): Promise<void> {
    const now = Date.now();
    const cutoff = now - DB_CLIENT_IDLE_TIMEOUT_MS;

    for (const [tenantId, entry] of this.clients.entries()) {
      if (entry.lastAccessedAt < cutoff) {
        const idleDuration = now - entry.lastAccessedAt;

        try {
          await entry.client.$disconnect();
        } catch (error) {
          logger.warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during eviction');
        }

        this.clients.delete(tenantId);

        logger.info(
          { tenantId, idleDuration, totalClients: this.clients.size },
          `[DB Client Manager] Evicted idle client for tenant: ${tenantId}. Idle for: ${idleDuration}ms. Active clients remaining: ${this.clients.size}`
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
        logger.error({ error: extractErrorDetails(error) }, 'Error during idle client eviction');
      });
    }, DB_CLIENT_CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  reset(): void {
    this.stopCleanup();
    this.clients.clear();
    this.creationLocks.clear();
  }

  async closeAll(): Promise<void> {
    this.stopCleanup();

    for (const [tenantId, entry] of this.clients.entries()) {
      try {
        await entry.client.$disconnect();
      } catch (error) {
        logger.warn({ tenantId, error: extractErrorDetails(error) }, 'Failed to disconnect during shutdown');
      }
    }

    this.clients.clear();
    this.creationLocks.clear();
  }
}

const clientManager = new ClientManager();

export function getClient(tenantId: string): PrismaClient | undefined {
  return clientManager.getClient(tenantId);
}

export async function createClient(config: TenantConfig): Promise<PrismaClient> {
  return clientManager.createClient(config);
}

export async function closeClient(tenantId: string): Promise<void> {
  return clientManager.closeClient(tenantId);
}

export async function closeAllClients(): Promise<void> {
  return clientManager.closeAll();
}

export function startClientCleanup(): void {
  clientManager.startCleanup();
}

export function stopClientCleanup(): void {
  clientManager.stopCleanup();
}

export function getClientCount(): number {
  return clientManager['clients'].size;
}

export function resetClientManager(): void {
  clientManager.reset();
}

/**
 * Check if client is still valid (not evicted due to idle timeout)
 */
export function isClientValid(tenantId: string): boolean {
  const entry = clientManager['clients'].get(tenantId);
  if (!entry) return false;

  const now = Date.now();
  const isIdle = now - entry.lastAccessedAt > DB_CLIENT_IDLE_TIMEOUT_MS;
  return !isIdle;
}

/**
 * Touch client to prevent eviction during long-running operations
 */
export function touchClient(tenantId: string): boolean {
  const entry = clientManager['clients'].get(tenantId);
  if (entry) {
    entry.lastAccessedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Detect connection errors from Prisma/PostgreSQL
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
 * Ensure client is valid, recreate if evicted or invalid
 */
export async function ensureClient(tenantId: string, config: TenantConfig): Promise<PrismaClient> {
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
  operation: (db: PrismaClient) => Promise<T>,
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
        logger.error({ tenantId, attempt, error: extractErrorDetails(error) }, 'DB operation failed after max retries');
        throw error;
      }

      logger.error({ tenantId, attempt, error: extractErrorDetails(error) }, 'DB connection error, retrying...');

      await closeClient(tenantId).catch((err) => {
        logger.debug({ tenantId, error: extractErrorDetails(err) }, 'Failed to close invalid client');
      });

      await sleep(retryDelayMs);
    }
  }

  throw new Error('Unreachable: DB operation failed');
}
