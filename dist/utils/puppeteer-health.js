"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPuppeteerHealth = checkPuppeteerHealth;
exports.clearPuppeteerHealthCache = clearPuppeteerHealthCache;
const logger_1 = require("./logger");
let cachedStatus = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30000; // Cache for 30 seconds
async function checkPuppeteerHealth() {
    const now = Date.now();
    if (cachedStatus && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedStatus;
    }
    try {
        const memoryUsage = process.memoryUsage();
        const memoryMb = Math.round(memoryUsage.heapUsed / 1024 / 1024);
        const limitMb = parseInt(process.env.KICK_PUPPETEER_MEMORY_LIMIT_MB || '512', 10);
        if (memoryMb > limitMb) {
            cachedStatus = {
                status: 'high_memory',
                instanceMemoryMb: memoryMb,
            };
        }
        else {
            cachedStatus = {
                status: 'ok',
                instanceMemoryMb: memoryMb,
            };
        }
        cacheTimestamp = now;
        return cachedStatus;
    }
    catch (error) {
        logger_1.logger.warn({ error }, 'Failed to check Puppeteer health');
        cachedStatus = { status: 'unavailable' };
        cacheTimestamp = now;
        return cachedStatus;
    }
}
function clearPuppeteerHealthCache() {
    cachedStatus = null;
    cacheTimestamp = 0;
}
//# sourceMappingURL=puppeteer-health.js.map