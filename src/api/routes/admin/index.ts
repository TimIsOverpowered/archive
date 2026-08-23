import type { FastifyInstance } from 'fastify';
import dmcaProcessingRoutes from './dmca.routes.ts';
import downloadJobsRoutes from './download.routes.ts';
import gameUploadRoutes from './game-upload.routes.ts';
import liveCallbackRoutes from './live-callback.routes.ts';
import metadataFetchingRoutes from './metadata.routes.ts';
import vodManagementRoutes from './vod-management.routes.ts';
import youtubeUploadRoutes from './youtube-upload.routes.ts';

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

export { default as authRoutes } from './auth.routes.ts';
export { default as tenantsRoutes } from './tenants.routes.ts';
