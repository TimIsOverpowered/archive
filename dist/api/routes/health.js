"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthRoutes;
const loader_1 = require("../../config/loader");
const client_1 = require("../../db/client");
const puppeteer_health_1 = require("../../utils/puppeteer-health");
const health_check_1 = __importDefault(require("../middleware/health-check"));
async function healthRoutes(fastify, _options) {
    fastify.get('/health', {
        schema: {
            tags: ['Health'],
            description: 'Health check endpoint for monitoring',
            headers: {
                type: 'object',
                properties: {
                    'x-health-token': { type: 'string', description: 'Health check token' },
                },
                required: ['x-health-token'],
            },
        },
        onRequest: health_check_1.default,
    }, async () => {
        const redis = fastify.redis;
        const streamerConfigs = await (0, loader_1.loadStreamerConfigs)();
        let redisStatus = 'ok';
        try {
            await redis.ping();
        }
        catch {
            redisStatus = 'error';
        }
        const streamers = [];
        for (const config of streamerConfigs) {
            const client = (0, client_1.getClient)(config.id);
            let dbStatus = 'ok';
            if (client) {
                try {
                    await client.$queryRaw `SELECT 1`;
                }
                catch {
                    dbStatus = 'error';
                }
            }
            streamers.push({
                id: config.id,
                db: dbStatus,
            });
        }
        const kickConfig = streamerConfigs.find((c) => c.kick?.enabled);
        const puppeteerHealth = await (0, puppeteer_health_1.checkPuppeteerHealth)();
        const response = {
            data: {
                status: 'ok',
                redis: redisStatus,
                streamers,
                ...(kickConfig && {
                    kick: {
                        puppeteer: puppeteerHealth.status,
                        instanceMemoryMb: puppeteerHealth.instanceMemoryMb,
                    },
                }),
            },
        };
        return response;
    });
}
//# sourceMappingURL=health.js.map