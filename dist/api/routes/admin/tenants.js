"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = tenantsRoutes;
const tenants_service_1 = require("../../../services/tenants.service");
const client_1 = require("../../../db/client");
const loader_1 = require("../../../config/loader");
const rate_limit_1 = __importDefault(require("../../middleware/rate-limit"));
const admin_jwt_1 = __importDefault(require("../../middleware/admin-jwt"));
async function tenantsRoutes(fastify, _options) {
    const rateLimitMiddleware = (0, rate_limit_1.default)({
        limiter: fastify.adminRateLimiter,
    });
    fastify.get('/', {
        schema: {
            tags: ['Admin', 'Tenants'],
            description: 'List all tenants (streamers)',
            security: [{ bearer: [] }],
        },
        onRequest: [admin_jwt_1.default, rateLimitMiddleware],
    }, async () => {
        const tenants = await (0, tenants_service_1.getAllTenants)();
        return { data: tenants };
    });
    fastify.get('/:id/stats', {
        schema: {
            tags: ['Admin', 'Tenants'],
            description: 'Get detailed stats for a tenant',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Tenant ID' },
                },
                required: ['id'],
            },
            security: [{ bearer: [] }],
        },
        onRequest: [admin_jwt_1.default, rateLimitMiddleware],
    }, async (request) => {
        const { id } = request.params;
        const config = (0, loader_1.getStreamerConfig)(id);
        if (!config) {
            throw new Error('Tenant not found');
        }
        const client = (0, client_1.getClient)(id);
        if (!client) {
            throw new Error('Database not available');
        }
        const stats = await (0, tenants_service_1.getTenantStats)(client, id);
        return { data: stats };
    });
    fastify.post('/:id/vods/:vodId/reupload', {
        schema: {
            tags: ['Admin', 'Tenants'],
            description: 'Manually trigger YouTube re-upload for a VOD (stub - Phase 3)',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Tenant ID' },
                    vodId: { type: 'string', description: 'VOD ID to re-upload' },
                },
                required: ['id', 'vodId'],
            },
            security: [{ bearer: [] }],
        },
        onRequest: [admin_jwt_1.default, rateLimitMiddleware],
    }, async (request) => {
        const { id, vodId } = request.params;
        const config = (0, loader_1.getStreamerConfig)(id);
        if (!config) {
            throw new Error('Tenant not found');
        }
        return {
            data: {
                message: 'Re-upload job queued (stub - Phase 3)',
                jobId: `stub-${id}-${vodId}-${Date.now()}`,
            },
        };
    });
}
//# sourceMappingURL=tenants.js.map