import { PrismaClient } from '../../generated/streamer/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TenantConfig } from '../config/types';
import { logger } from '../utils/logger.js';
import { extractErrorDetails } from '../utils/error.js';
import { DB_CLIENT_IDLE_TIMEOUT_MS, DB_CLIENT_MAX_CLIENTS, DB_CLIENT_CLEANUP_INTERVAL_MS } from '../constants.js';
import { invalidateVodCache } from '../services/vod-cache.js';

const cacheInvalidationExtension = (tenantId: string, baseClient: PrismaClient) =>
  baseClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isMutation = ['create', 'update', 'upsert', 'delete', 'createMany', 'updateMany', 'deleteMany'].includes(operation);
          const isRelevantModel = ['Vod', 'VodUpload', 'Emote', 'Chapter', 'Game'].includes(model);

          if (!isMutation || !isRelevantModel) {
            return query(args);
          }

          try {
            const result = await query(args);

            const affectedVodIds: number[] = [];

            if (model === 'Vod') {
              if (operation === 'delete' || operation === 'update' || operation === 'upsert') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'id' in where) {
                  const idValue = (where as { id: unknown }).id;
                  if (Array.isArray(idValue)) {
                    affectedVodIds.push(...idValue.map((id) => Number(id)).filter((id) => !isNaN(id)));
                  } else {
                    const numId = Number(idValue);
                    if (!isNaN(numId)) affectedVodIds.push(numId);
                  }
                }
              } else if (operation === 'create') {
                if (result && typeof result === 'object' && 'id' in result) {
                  const numId = Number((result as { id: unknown }).id);
                  if (!isNaN(numId)) affectedVodIds.push(numId);
                }
              } else if (operation === 'createMany') {
                const data = (args as { data?: unknown[] }).data;
                if (Array.isArray(data) && data.length > 0) {
                  const extractedIds = data
                    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && 'id' in (item as Record<string, unknown>))
                    .map((item) => Number((item as { id: unknown }).id))
                    .filter((id) => !isNaN(id));

                  if (extractedIds.length === 0 && data.length > 0) {
                    logger.debug({ tenantId, operation, recordCount: data.length }, 'Vod.createMany called without explicit IDs — cache invalidation skipped');
                  }

                  affectedVodIds.push(...extractedIds);
                }
              } else if (operation === 'deleteMany' || operation === 'updateMany') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'id' in where) {
                  const idClause = (where as { id: unknown }).id;
                  if (idClause && typeof idClause === 'object' && 'in' in idClause) {
                    const idArray = idClause.in as unknown[];
                    if (Array.isArray(idArray)) {
                      affectedVodIds.push(...idArray.map((id) => Number(id)).filter((id) => !isNaN(id)));
                    }
                  } else if (typeof idClause !== 'object' && idClause !== null && idClause !== undefined) {
                    const numId = Number(idClause);
                    if (!isNaN(numId)) affectedVodIds.push(numId);
                  }
                }
              }
            } else {
              if (operation === 'delete' || operation === 'update' || operation === 'upsert') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'vod_id' in where) {
                  const vodIdClause = (where as { vod_id: unknown }).vod_id;
                  if (vodIdClause && typeof vodIdClause === 'object' && 'in' in vodIdClause) {
                    const idArray = vodIdClause.in as unknown[];
                    if (Array.isArray(idArray)) {
                      affectedVodIds.push(...idArray.map((id) => Number(id)).filter((id) => !isNaN(id)));
                    }
                  } else if (typeof vodIdClause !== 'object' && vodIdClause !== null && vodIdClause !== undefined) {
                    const numId = Number(vodIdClause);
                    if (!isNaN(numId)) affectedVodIds.push(numId);
                  }
                }
              } else if (operation === 'create') {
                const data = (args as { data?: Record<string, unknown> }).data;
                if (data && typeof data === 'object' && 'vod_id' in data) {
                  const numId = Number((data as { vod_id: unknown }).vod_id);
                  if (!isNaN(numId)) affectedVodIds.push(numId);
                }
              } else if (operation === 'createMany') {
                const data = (args as { data?: unknown[] }).data;
                if (Array.isArray(data) && data.length > 0) {
                  affectedVodIds.push(
                    ...data
                      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && 'vod_id' in (item as Record<string, unknown>))
                      .map((item) => Number((item as { vod_id: unknown }).vod_id))
                      .filter((id) => !isNaN(id))
                  );
                }
              } else if (operation === 'updateMany' || operation === 'deleteMany') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'vod_id' in where) {
                  const vodIdClause = (where as { vod_id: unknown }).vod_id;
                  if (vodIdClause && typeof vodIdClause === 'object' && 'in' in vodIdClause) {
                    const idArray = vodIdClause.in as unknown[];
                    if (Array.isArray(idArray)) {
                      affectedVodIds.push(...idArray.map((id) => Number(id)).filter((id) => !isNaN(id)));
                    }
                  } else if (typeof vodIdClause !== 'object' && vodIdClause !== null && vodIdClause !== undefined) {
                    const numId = Number(vodIdClause);
                    if (!isNaN(numId)) affectedVodIds.push(numId);
                  }
                }
              }
            }

            const uniqueIds = [...new Set(affectedVodIds)].filter((id) => !isNaN(id));

            for (const id of uniqueIds) {
              invalidateVodCache(tenantId, id).catch((error) => {
                logger.warn({ tenantId, vodId: id, error: extractErrorDetails(error) }, 'Cache invalidation failed');
              });

              logger.debug({ tenantId, vodId: id, model, operation }, 'VOD cache invalidated via extension');
            }

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
