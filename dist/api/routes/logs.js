"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = logsRoutes;
const logs_service_1 = require("../../services/logs.service");
const client_1 = require("../../db/client");
const loader_1 = require("../../config/loader");
const rate_limit_1 = __importDefault(require("../middleware/rate-limit"));
async function logsRoutes(fastify, _options) {
    const rateLimitMiddleware = (0, rate_limit_1.default)({
        limiter: fastify.chatRateLimiter,
    });
    fastify.get('/:streamerId/:vodId/logs', {
        schema: {
            tags: ['Chat Logs'],
            description: 'Get chat logs for a VOD with pagination',
            params: {
                type: 'object',
                properties: {
                    streamerId: { type: 'string', description: 'Streamer ID' },
                    vodId: { type: 'string', description: 'VOD ID' },
                },
                required: ['streamerId', 'vodId'],
            },
            query: {
                type: 'object',
                properties: {
                    content_offset_seconds: {
                        type: 'number',
                        description: 'Start from this timestamp (offset-based pagination)',
                    },
                    cursor: {
                        type: 'string',
                        description: 'Continue from cursor (cursor-based pagination, base64-encoded)',
                    },
                },
            },
        },
        onRequest: rateLimitMiddleware,
    }, async (request) => {
        const { streamerId, vodId } = request.params;
        const { content_offset_seconds, cursor } = request.query;
        if (!content_offset_seconds && !cursor) {
            throw new Error('Missing required query parameter: content_offset_seconds or cursor');
        }
        const config = (0, loader_1.getStreamerConfig)(streamerId);
        if (!config) {
            throw new Error('Streamer not found');
        }
        const client = (0, client_1.getClient)(streamerId);
        if (!client) {
            throw new Error('Database not available');
        }
        let result;
        if (cursor) {
            result = await (0, logs_service_1.getLogsByCursor)(client, streamerId, vodId, cursor);
        }
        else if (content_offset_seconds !== undefined && !isNaN(content_offset_seconds)) {
            result = await (0, logs_service_1.getLogsByOffset)(client, streamerId, vodId, content_offset_seconds);
        }
        else {
            throw new Error('Invalid content_offset_seconds value');
        }
        return { data: result };
    });
}
//# sourceMappingURL=logs.js.map