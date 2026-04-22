import { FastifyPluginAsync } from 'fastify';
import { loadTenantConfigs, getTenantConfig, clearConfigCache, reloadTenantConfig } from '../../config/loader.js';
import { TenantConfig } from '../../config/types.js';
import { getLogger } from '../../utils/logger.js';
import { extractErrorDetails } from '../../utils/error.js';

const configPlugin: FastifyPluginAsync = async (fastify) => {
  try {
    getLogger().info('Loading streamer configurations from meta database');

    const configs = await loadTenantConfigs();

    getLogger().info(
      { count: configs.length, streamers: configs.map((c) => c.id) },
      'Streamer configs loaded (DB clients will lazy-load on demand)'
    );

    // Decorate fastify with config helpers
    fastify.decorate('getTenantConfig', (id: string): TenantConfig | undefined => {
      return getTenantConfig(id);
    });

    fastify.decorate('getAllConfigs', async (): Promise<TenantConfig[]> => {
      return loadTenantConfigs();
    });

    fastify.decorate('clearConfigCache', (tenantId?: string): void => {
      clearConfigCache(tenantId);
    });

    fastify.decorate('reloadTenantConfig', async (id: string): Promise<TenantConfig | undefined> => {
      return reloadTenantConfig(id);
    });

    // Add hook to reload configs on demand (for admin endpoints)
    fastify.addHook('onClose', async () => {
      getLogger().info('Clearing config cache on shutdown');
      clearConfigCache();
    });
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().fatal({ ...details }, 'Failed to load streamer configurations');
    throw error;
  }
};

export default configPlugin;
