import { FastifyInstance } from 'fastify';
import tenantsRoutes from './tenants.js';

interface AdminRoutesOptions {
  prefix: string;
}

export default async function adminRoutes(fastify: FastifyInstance, _options: AdminRoutesOptions) {
  await fastify.register(tenantsRoutes);
}
