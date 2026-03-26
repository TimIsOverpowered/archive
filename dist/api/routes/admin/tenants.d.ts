import { FastifyInstance } from 'fastify';
type TenantsRoutesOptions = Record<string, unknown>;
declare module 'fastify' {
    interface FastifyInstance {
        adminRateLimiter: any;
    }
}
export default function tenantsRoutes(fastify: FastifyInstance, _options: TenantsRoutesOptions): Promise<void>;
export {};
//# sourceMappingURL=tenants.d.ts.map