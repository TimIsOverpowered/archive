import { FastifyRequest, FastifyReply } from 'fastify';
export interface AdminUser {
    id: number;
    username: string;
}
declare module 'fastify' {
    interface FastifyRequest {
        user?: AdminUser;
    }
}
export declare function adminAuth(): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
//# sourceMappingURL=admin.d.ts.map