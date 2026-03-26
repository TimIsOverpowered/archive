interface AdminAuthResponse {
    token: string;
}
export declare function validateApiKey(apiKey: string): Promise<boolean>;
export declare function generateAdminJwt(fastify: any, apiKey: string): Promise<AdminAuthResponse>;
export {};
//# sourceMappingURL=admin.service.d.ts.map