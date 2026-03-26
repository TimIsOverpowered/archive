"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const loader_1 = require("../../config/loader");
const logger_1 = require("../../utils/logger");
const configPlugin = async (fastify) => {
    try {
        logger_1.logger.info('Loading streamer configurations from meta database');
        const configs = await (0, loader_1.loadStreamerConfigs)();
        logger_1.logger.info({ count: configs.length, streamers: configs.map((c) => c.id) }, 'Streamer configs loaded');
        // Decorate fastify with config helpers
        fastify.decorate('getStreamerConfig', (id) => {
            return (0, loader_1.getConfigById)(id);
        });
        fastify.decorate('getAllConfigs', async () => {
            return (0, loader_1.loadStreamerConfigs)();
        });
        fastify.decorate('clearConfigCache', () => {
            (0, loader_1.clearConfigCache)();
        });
        // Add hook to reload configs on demand (for admin endpoints)
        fastify.addHook('onClose', async () => {
            logger_1.logger.info('Clearing config cache on shutdown');
            (0, loader_1.clearConfigCache)();
        });
    }
    catch (error) {
        logger_1.logger.fatal({ error }, 'Failed to load streamer configurations');
        throw error;
    }
};
exports.default = configPlugin;
//# sourceMappingURL=config.plugin.js.map