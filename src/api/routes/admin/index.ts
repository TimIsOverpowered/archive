import { FastifyInstance } from 'fastify';
import dmcaProcessingRoutes from './dmca.routes';
import downloadJobsRoutes from './download.routes';
import gameUploadRoutes from './game-upload.routes';
import liveCallbackRoutes from './live-callback.routes';
import metadataFetchingRoutes from './metadata.routes';
import vodManagementRoutes from './vod-management.routes';
import youtubeUploadRoutes from './youtube-upload.routes';

/** Options for registering the admin routes plugin. */
interface AdminRoutesOptions {
  prefix: string;
}

/**
 * Register all admin sub-routes: download jobs, YouTube uploads, DMCA, metadata, live callbacks, VOD management.
 */
export default async function adminRoutes(fastify: FastifyInstance, _options: AdminRoutesOptions) {
  await fastify.register(downloadJobsRoutes);

  await fastify.register(youtubeUploadRoutes);

  await fastify.register(gameUploadRoutes);

  await fastify.register(dmcaProcessingRoutes);

  await fastify.register(metadataFetchingRoutes);

  await fastify.register(vodManagementRoutes);

  await fastify.register(liveCallbackRoutes, { prefix: '' });
}

export { default as globalAdminRoutes } from './global.routes';
