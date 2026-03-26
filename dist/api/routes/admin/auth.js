"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = authRoutes;
const admin_service_1 = require("../../../services/admin.service");
const rate_limit_1 = __importDefault(require("../../middleware/rate-limit"));
async function authRoutes(fastify, _options) {
    const rateLimitMiddleware = (0, rate_limit_1.default)({
        limiter: fastify.adminRateLimiter,
    });
    fastify.post('/key', {
        schema: {
            tags: ['Admin', 'Auth'],
            description: 'Exchange API key for JWT token',
            headers: {
                type: 'object',
                properties: {
                    'x-api-key': {
                        type: 'string',
                        description: 'Admin API key (must start with archive_)',
                        pattern: '^archive_[0-9a-f]{64}$',
                    },
                },
                required: ['x-api-key'],
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        data: {
                            type: 'object',
                            properties: {
                                token: { type: 'string' },
                            },
                        },
                    },
                },
            },
        },
        onRequest: rateLimitMiddleware,
    }, async (request) => {
        const apiKey = request.headers['x-api-key'];
        if (!apiKey || !apiKey.startsWith('archive_')) {
            throw new Error('Invalid API key format');
        }
        try {
            const { token } = await (0, admin_service_1.generateAdminJwt)(fastify, apiKey);
            return { data: { token } };
        }
        catch (error) {
            throw error;
        }
    });
}
//# sourceMappingURL=auth.js.map