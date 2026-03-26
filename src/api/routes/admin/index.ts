import { FastifyInstance } from 'fastify';
import authRoutes from './auth';
import tenantsRoutes from './tenants';

interface AdminRoutesOptions {
  prefix: string;
}

export default async function adminRoutes(fastify: FastifyInstance, _options: AdminRoutesOptions) {
  await fastify.register(authRoutes);
  await fastify.register(tenantsRoutes);
}
