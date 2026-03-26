"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = vodsRoutes;
const vods_service_1 = require("../../services/vods.service");
const client_1 = require("../../db/client");
const loader_1 = require("../../config/loader");
const rate_limit_1 = __importDefault(require("../middleware/rate-limit"));
async function vodsRoutes(fastify, _options) {
    const rateLimitMiddleware = (0, rate_limit_1.default)({
        limiter: fastify.publicRateLimiter,
    });
    fastify.get('/:streamerId', {
        schema: {
            tags: ['VODs'],
            description: 'List all VODs for a streamer with filtering and pagination',
            params: {
                type: 'object',
                properties: {
                    streamerId: { type: 'string', description: 'Streamer ID' },
                },
                required: ['streamerId'],
            },
            query: {
                type: 'object',
                properties: {
                    platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Filter by source platform' },
                    from: { type: 'string', format: 'date-time', description: 'Filter VODs after date (ISO)' },
                    to: { type: 'string', format: 'date-time', description: 'Filter VODs before date (ISO)' },
                    uploaded: { type: 'string', enum: ['youtube'], description: 'Only VODs with YouTube uploads' },
                    game: { type: 'string', description: 'Fuzzy search in chapters.name' },
                    page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Items per page' },
                    sort: { type: 'string', enum: ['created_at', 'duration', 'uploaded_at'], default: 'created_at' },
                    order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
                },
            },
        },
        onRequest: rateLimitMiddleware,
    }, async (request) => {
        const { streamerId } = request.params;
        const query = request.query;
        const config = (0, loader_1.getStreamerConfig)(streamerId);
        if (!config) {
            throw new Error('Streamer not found');
        }
        const client = (0, client_1.getClient)(streamerId);
        if (!client) {
            throw new Error('Database not available');
        }
        const { vods, total } = await (0, vods_service_1.getVods)(client, streamerId, query);
        const page = Math.max(1, query.page || 1);
        const limit = Math.min(100, Math.max(1, query.limit || 20));
        return {
            data: vods,
            meta: {
                page,
                limit,
                total,
            },
        };
    });
    fastify.get('/:streamerId/:vodId', {
        schema: {
            tags: ['VODs'],
            description: 'Get a single VOD by ID',
            params: {
                type: 'object',
                properties: {
                    streamerId: { type: 'string', description: 'Streamer ID' },
                    vodId: { type: 'string', description: 'VOD ID' },
                },
                required: ['streamerId', 'vodId'],
            },
        },
        onRequest: rateLimitMiddleware,
    }, async (request) => {
        const { streamerId, vodId } = request.params;
        const config = (0, loader_1.getStreamerConfig)(streamerId);
        if (!config) {
            throw new Error('Streamer not found');
        }
        const client = (0, client_1.getClient)(streamerId);
        if (!client) {
            throw new Error('Database not available');
        }
        const vod = await (0, vods_service_1.getVodById)(client, streamerId, vodId);
        if (!vod) {
            throw new Error('VOD not found');
        }
        return { data: vod };
    });
}
//# sourceMappingURL=vods.js.map