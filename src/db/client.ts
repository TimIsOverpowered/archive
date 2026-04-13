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

            let vodId: number | null = null;

            if (model === 'Vod') {
              if (operation === 'delete' || operation === 'update' || operation === 'upsert') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'id' in where) {
                  vodId = Number((where as { id: unknown }).id);
                }
              } else if (operation === 'create') {
                if (result && typeof result === 'object' && 'id' in result) {
                  vodId = Number((result as { id: unknown }).id);
                }
              }
            } else {
              if (operation === 'delete' || operation === 'update' || operation === 'upsert') {
                const where = (args as { where?: Record<string, unknown> }).where;
                if (where && typeof where === 'object' && 'vod_id' in where) {
                  vodId = Number((where as { vod_id: unknown }).vod_id);
                }
              } else if (operation === 'create') {
                const data = (args as { data?: Record<string, unknown> }).data;
                if (data && typeof data === 'object' && 'vod_id' in data) {
                  vodId = Number((data as { vod_id: unknown }).vod_id);
                }
              } else if (operation.includes('Many')) {
                const data = (args as { data?: unknown[] }).data;
                if (Array.isArray(data) && data.length > 0) {
                  const firstItem = data[0] as Record<string, unknown>;
                  if ('vod_id' in firstItem) {
                    vodId = Number(firstItem.vod_id);
                  }
                }
              }
            }

            if (vodId !== null && !isNaN(vodId)) {
              invalidateVodCache(tenantId, vodId).catch((error) => {
                logger.warn({ tenantId, vodId, error: extractErrorDetails(error) }, 'Cache invalidation failed');
              });

              logger.debug({ tenantId, vodId, model, operation }, 'VOD cache invalidated via extension');
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
  clientManager['clients'].clear();
  clientManager['creationLocks'].clear();
  if (clientManager['cleanupIntervalId'] !== null) {
    clearInterval(clientManager['cleanupIntervalId']);
    clientManager['cleanupIntervalId'] = null;
  }
}
