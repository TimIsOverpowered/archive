import { FastifyInstance } from 'fastify';
import dmcaProcessingRoutes from './dmca.routes.js';
import downloadJobsRoutes from './download.routes.js';
import gameUploadRoutes from './game-upload.routes.js';
import liveCallbackRoutes from './live-callback.routes.js';
import metadataFetchingRoutes from './metadata.routes.js';
import vodManagementRoutes from './vod-management.routes.js';
import youtubeUploadRoutes from './youtube-upload.routes.js';

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

  await fastify.register(liveCallbackRoutes);
}

export { default as authRoutes } from './auth.routes.js';
export { default as tenantsRoutes } from './tenants.routes.js';
