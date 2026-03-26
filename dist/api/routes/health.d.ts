import { FastifyInstance } from 'fastify';
import { RedisClientType } from 'redis';
interface HealthRouteOptions {
    prefix: string;
}
declare module 'fastify' {
    interface FastifyInstance {
        redis: RedisClientType;
        getAllConfigs: () => Promise<any[]>;
    }
}
export default function healthRoutes(fastify: FastifyInstance, _options: HealthRouteOptions): Promise<void>;
export {};
//# sourceMappingURL=health.d.ts.map