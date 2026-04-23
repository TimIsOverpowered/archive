import fp from 'fastify-plugin';
import { configService } from '../../config/tenant-config.js';
import { getLogger } from '../../utils/logger.js';

const configPlugin = fp(async (_fastify) => {
  getLogger().info('Loading streamer configurations from meta database');
  const configs = await configService.loadAll();
  getLogger().info(
    { count: configs.length, streamers: configs.map((c) => c.id) },
    'Streamer configs loaded (DB clients will lazy-load on demand)'
  );
});

export default configPlugin;
