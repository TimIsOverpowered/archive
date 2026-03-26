import { FastifyInstance } from 'fastify';
interface VodRoutesOptions {
    prefix: string;
}
declare module 'fastify' {
    interface FastifyInstance {
        publicRateLimiter: any;
    }
}
export default function vodsRoutes(fastify: FastifyInstance, _options: VodRoutesOptions): Promise<void>;
export {};
//# sourceMappingURL=vods.d.ts.map