import { FastifyPluginAsync } from 'fastify';
import { loadStreamerConfigs, getConfigById, clearConfigCache } from '../../config/loader';
import { StreamerConfig } from '../../config/types';
import { logger } from '../../utils/logger';

const configPlugin: FastifyPluginAsync = async (fastify) => {
  try {
    logger.info('Loading streamer configurations from meta database');

    const configs = await loadStreamerConfigs();

    logger.info({ count: configs.length, streamers: configs.map((c) => c.id) }, 'Streamer configs loaded');

    // Decorate fastify with config helpers
    fastify.decorate('getStreamerConfig', (id: string): StreamerConfig | undefined => {
      return getConfigById(id);
    });

    fastify.decorate('getAllConfigs', async (): Promise<StreamerConfig[]> => {
      return loadStreamerConfigs();
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
