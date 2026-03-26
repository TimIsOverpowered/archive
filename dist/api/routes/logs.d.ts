import { FastifyInstance } from 'fastify';
interface LogsRoutesOptions {
    prefix: string;
}
declare module 'fastify' {
    interface FastifyInstance {
        chatRateLimiter: any;
    }
}
export default function logsRoutes(fastify: FastifyInstance, _options: LogsRoutesOptions): Promise<void>;
export {};
//# sourceMappingURL=logs.d.ts.map