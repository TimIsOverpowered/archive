import { FastifyInstance } from 'fastify';
import downloadJobsRoutes from './download.routes';
import youtubeUploadRoutes from './youtube-upload.routes';
import dmcaProcessingRoutes from './dmca.routes';
import metadataFetchingRoutes from './metadata.routes';
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
