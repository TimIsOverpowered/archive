import { FastifyPluginAsync } from 'fastify';
import { loadTenantConfigs, getTenantConfig, clearConfigCache } from '../../config/loader';
import { createClient } from '../../db/client';
import { TenantConfig } from '../../config/types';
import { logger } from '../../utils/logger';

const configPlugin: FastifyPluginAsync = async (fastify) => {
  try {
    logger.info('Loading streamer configurations from meta database');

    const configs = await loadTenantConfigs();

    logger.info({ count: configs.length, streamers: configs.map((c) => c.id) }, 'Streamer configs loaded');

    // Initialize database clients for each streamer
    for (const config of configs) {
      try {
        await createClient(config);
        logger.info({ tenantId: config.id }, 'Database client initialized');
      } catch (error) {
        logger.error({ tenantId: config.id, error }, 'Failed to initialize database client');
        throw error;
      }
    }

    // Decorate fastify with config helpers
    fastify.decorate('getTenantConfig', (id: string): TenantConfig | undefined => {
      return getTenantConfig(id);
    });

    fastify.decorate('getAllConfigs', async (): Promise<TenantConfig[]> => {
      return loadTenantConfigs();
    });

    fastify.decorate('clearConfigCache', (): void => {
      clearConfigCache();
    });

    // Add hook to reload configs on demand (for admin endpoints)
    fastify.addHook('onClose', async () => {
      logger.info('Clearing config cache on shutdown');
      clearConfigCache();
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to load streamer configurations');
    throw error;
  }
};

export default configPlugin;
