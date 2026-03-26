"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRateLimiter = exports.chatRateLimiter = exports.publicRateLimiter = exports.redisClient = void 0;
const redis_1 = require("redis");
const rate_limiter_flexible_1 = require("rate-limiter-flexible");
const logger_1 = require("../../utils/logger");
exports.redisClient = null;
exports.publicRateLimiter = null;
exports.chatRateLimiter = null;
exports.adminRateLimiter = null;
const redisPlugin = async (fastify, options) => {
    const { url } = options;
    const maskedUrl = url.replace(/:\/\/.*@/, '://***@');
    logger_1.logger.info({ url: maskedUrl }, 'Connecting to Redis');
    const isProduction = process.env.NODE_ENV === 'production';
    let errorCount = 0;
    let connectCount = 0;
    const maxErrorsBeforeFail = isProduction ? 5 : 3;
    const readyTimeout = isProduction ? 30000 : 10000;
    try {
        exports.redisClient = (0, redis_1.createClient)({
            url,
            socket: {
                reconnectStrategy: (retries) => {
                    if (retries > 10)
                        return new Error('Max Redis reconnection attempts reached');
                    const delay = Math.min(retries * 500, 5000);
                    logger_1.logger.warn({ retries, delay }, 'Redis reconnection attempt');
                    return delay;
                },
            },
        });
        exports.redisClient.on('error', (err) => {
            errorCount++;
            logger_1.logger.error({ err, errorCount }, 'Redis connection error');
            if (errorCount >= maxErrorsBeforeFail) {
                const errorMsg = `Redis connection unstable after ${errorCount} errors`;
                logger_1.logger.fatal({ error: err.message }, errorMsg);
                exports.redisClient.quit().catch(() => { });
                throw new Error(errorMsg);
            }
        });
        exports.redisClient.on('connect', () => {
            connectCount++;
            if (errorCount === 0) {
                logger_1.logger.info('Redis connected');
            }
        });
        // Wait for ready event with timeout (register BEFORE connect)
        let readyResolved = false;
        const readyPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                exports.redisClient.off('ready', readyHandler);
                const errorMsg = `Redis did not become ready after ${readyTimeout}ms (${errorCount} errors, ${connectCount} connects)`;
                logger_1.logger.error({ errorCount, connectCount }, errorMsg);
                reject(new Error(errorMsg));
            }, readyTimeout);
            const readyHandler = () => {
                if (readyResolved)
                    return;
                readyResolved = true;
                clearTimeout(timeoutId);
                logger_1.logger.info('Redis client ready - connection stable');
                resolve(true);
            };
            exports.redisClient.on('ready', readyHandler);
        });
        // Add timeout to connection attempt
        logger_1.logger.info('Attempting Redis connection...');
        const connectPromise = exports.redisClient.connect();
        await connectPromise;
        await readyPromise;
        logger_1.logger.info('Redis connection established');
        fastify.decorate('redis', exports.redisClient);
        // Initialize rate limiters from env vars
        const vodLimit = parseInt(process.env.RATE_LIMIT_VODS || '60', 10);
        const chatLimit = parseInt(process.env.RATE_LIMIT_CHAT || '30', 10);
        const adminGetLimit = parseInt(process.env.RATE_LIMIT_ADMIN_GET || '60', 10);
        const blockDuration = parseInt(process.env.RATE_LIMIT_BLOCK_DURATION || '60', 10);
        exports.publicRateLimiter = new rate_limiter_flexible_1.RateLimiterRedis({
            storeClient: exports.redisClient,
            keyPrefix: 'rate:vods',
            points: vodLimit,
            duration: 60,
            blockDuration: blockDuration,
        });
        fastify.decorate('publicRateLimiter', exports.publicRateLimiter);
        exports.chatRateLimiter = new rate_limiter_flexible_1.RateLimiterRedis({
            storeClient: exports.redisClient,
            keyPrefix: 'rate:chat',
            points: chatLimit,
            duration: 60,
            blockDuration: blockDuration * 2,
        });
        fastify.decorate('chatRateLimiter', exports.chatRateLimiter);
        exports.adminRateLimiter = new rate_limiter_flexible_1.RateLimiterRedis({
            storeClient: exports.redisClient,
            keyPrefix: 'rate:admin',
            points: adminGetLimit,
            duration: 60,
            blockDuration: blockDuration * 5,
        });
        fastify.decorate('adminRateLimiter', exports.adminRateLimiter);
        logger_1.logger.info({ vodLimit, chatLimit, adminGetLimit }, 'Rate limiters initialized');
    }
    catch (error) {
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction) {
            logger_1.logger.fatal({ error: error.message }, 'Failed to connect to Redis - server cannot start in production without Redis');
            throw error;
        }
        logger_1.logger.warn({ error: error.message }, 'Redis connection failed - running without Redis (rate limiting and caching disabled)');
        // Create mock/no-op implementations for development
        fastify.decorate('redis', {
            ping: async () => 'PONG',
            get: async () => null,
            set: async () => 'OK',
            del: async () => 1,
            getBuffer: async () => null,
            setBuffer: async () => 'OK',
        });
        // Mock rate limiters (always allow in dev without Redis)
        const mockLimiter = {
            consume: async () => ({ remainingPoints: 100 }),
            points: 100,
            duration: 60,
        };
        fastify.decorate('publicRateLimiter', mockLimiter);
        fastify.decorate('chatRateLimiter', mockLimiter);
        fastify.decorate('adminRateLimiter', mockLimiter);
    }
};
exports.default = redisPlugin;
//# sourceMappingURL=redis.plugin.js.map