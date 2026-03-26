"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildServer = buildServer;
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const compress_1 = __importDefault(require("@fastify/compress"));
const swagger_1 = __importDefault(require("@fastify/swagger"));
const swagger_ui_1 = __importDefault(require("@fastify/swagger-ui"));
const fastify_metrics_1 = __importDefault(require("fastify-metrics"));
const redis_plugin_1 = __importDefault(require("./plugins/redis.plugin"));
async function buildServer() {
    const fastify = (0, fastify_1.default)({
        bodyLimit: 25 * 1024 * 1024, // 25MB for large payloads
        exposeHeadRoutes: true,
    });
    // Setup logger with request ID tracking
    fastify.addHook('onRequest', async (request, reply) => {
        const xRequestId = request.headers['x-request-id'];
        const requestId = Array.isArray(xRequestId) ? xRequestId[0] : (xRequestId ?? crypto.randomUUID());
        request.log.reqId = requestId;
        reply.header('X-Request-ID', requestId);
    });
    // Security headers
    await fastify.register(helmet_1.default, {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginOpenerPolicy: false,
    });
    // Compression for large responses (>10KB)
    await fastify.register(compress_1.default, {
        threshold: 10240,
    });
    // Redis connection + rate limiters
    await fastify.register(redis_plugin_1.default, {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    });
    // Prometheus metrics (fastify-metrics v12+ API)
    await fastify.register(fastify_metrics_1.default, {
        endpoint: '/metrics',
    });
    // Swagger/OpenAPI documentation
    await fastify.register(swagger_1.default, {
        openapi: {
            info: {
                title: 'Archive API',
                description: 'VOD and Chat Management API for Streamers',
                version: '1.0.0',
            },
            servers: [{ url: 'https://archive.overpowered.tv/api/v1' }],
            components: {
                securitySchemes: {
                    bearer: {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                    apiKey: {
                        type: 'apiKey',
                        in: 'header',
                        name: 'X-API-Key',
                    },
                },
            },
            security: [],
        },
    });
    await fastify.register(swagger_ui_1.default, {
        routePrefix: '/docs',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: false,
        },
    });
    // Global CORS with route-based origin checking
    await fastify.register(cors_1.default, {
        origin: true,
        credentials: true,
        exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-ID'],
    });
    // Register public routes
    await fastify.register(async (instance) => {
        const healthRoutes = await Promise.resolve().then(() => __importStar(require('./routes/health')));
        const vodsRoutes = await Promise.resolve().then(() => __importStar(require('./routes/vods')));
        const logsRoutes = await Promise.resolve().then(() => __importStar(require('./routes/logs')));
        await instance.register(healthRoutes.default, { prefix: '/api/v1' });
        // Register VODs and logs under same prefix to avoid duplicate OPTIONS handlers
        await instance.register(async (vodInstance) => {
            await vodInstance.register(vodsRoutes.default, {});
            await vodInstance.register(logsRoutes.default, {});
        }, { prefix: '/api/v1/vods' });
    });
    // Register admin routes
    await fastify.register(async (instance) => {
        const adminRoutes = await Promise.resolve().then(() => __importStar(require('./routes/admin')));
        await instance.register(adminRoutes.default, { prefix: '/api/v1/admin' });
    });
    // Error handler
    fastify.setErrorHandler((error, request, reply) => {
        request.log.error({ err: error }, 'Request error');
        const statusCode = error.statusCode || 500;
        const code = error.code || 'INTERNAL_ERROR';
        return reply.status(statusCode).send({
            error: {
                message: error.message || 'Internal server error',
                code,
                statusCode,
            },
        });
    });
    // 404 handler
    fastify.setNotFoundHandler((request, reply) => {
        return reply.status(404).send({
            error: {
                message: 'Route not found',
                code: 'NOT_FOUND',
                statusCode: 404,
            },
        });
    });
    return fastify;
}
exports.default = buildServer;
//# sourceMappingURL=server.js.map