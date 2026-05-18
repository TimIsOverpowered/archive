import fp from 'fastify-plugin';
import { configService } from '../../config/tenant-config.js';
import { closeMetaClient } from '../../db/meta-client.js';
import { getLogger } from '../../utils/logger.js';

const configPlugin = fp(async (fastify) => {
  getLogger().info('Loading streamer configurations from meta database');
  const configs = await configService.loadAll();
  getLogger().debug(
    { count: configs.length, streamers: configs.map((c) => c.id) },
    'Streamer configs loaded (DB clients will lazy-load on demand)'
  );

  fastify.addHook('onClose', async () => {
    await closeMetaClient();
  });
});

export default configPlugin;
