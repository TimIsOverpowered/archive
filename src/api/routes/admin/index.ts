import { FastifyInstance } from 'fastify';
import vodManagementRoutes from './vod-management.routes';
import downloadJobsRoutes from './download-jobs.routes';
import youtubeUploadRoutes from './youtube-upload.routes';
import dmcaProcessingRoutes from './dmca-processing.routes';
import metadataFetchingRoutes from './metadata-fetching.routes';
import liveCallbackRoutes from './live-callback.routes';

interface AdminRoutesOptions {
  prefix: string;
}

export default async function adminRoutes(fastify: FastifyInstance, _options: AdminRoutesOptions) {
  // Register all domain-focused route modules

  await fastify.register(vodManagementRoutes);

  await fastify.register(downloadJobsRoutes);

  await fastify.register(youtubeUploadRoutes);

  await fastify.register(dmcaProcessingRoutes);

  await fastify.register(metadataFetchingRoutes);

  // Live callback endpoint for external recorders (twitch-recorder-go)
  await fastify.register(liveCallbackRoutes, { prefix: '' });
}
