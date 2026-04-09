import { FastifyInstance } from 'fastify';
import downloadJobsRoutes from './download-jobs.routes';
import youtubeUploadRoutes from './youtube-upload.routes';
import dmcaProcessingRoutes from './dmca-processing.routes';
import metadataFetchingRoutes from './metadata-fetching.routes';
import liveCallbackRoutes from './live-callback.routes';
import vodManagementRoutes from './vod-management.routes';

interface AdminRoutesOptions {
  prefix: string;
}

export default async function adminRoutes(fastify: FastifyInstance, _options: AdminRoutesOptions) {
  await fastify.register(downloadJobsRoutes);

  await fastify.register(youtubeUploadRoutes);

  await fastify.register(dmcaProcessingRoutes);

  await fastify.register(metadataFetchingRoutes);

  await fastify.register(vodManagementRoutes);

  await fastify.register(liveCallbackRoutes, { prefix: '' });
}

export { default as globalAdminRoutes } from './global.routes';
