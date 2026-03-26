import { FastifyInstance } from 'fastify';
type AuthRoutesOptions = Record<string, unknown>;
declare module 'fastify' {
    interface FastifyInstance {
        adminRateLimiter: any;
    }
}
export default function authRoutes(fastify: FastifyInstance, _options: AuthRoutesOptions): Promise<void>;
export {};
//# sourceMappingURL=auth.d.ts.map