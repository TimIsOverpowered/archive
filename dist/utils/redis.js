"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectWithBackoff = connectWithBackoff;
const ioredis_1 = __importDefault(require("ioredis"));
async function connectWithBackoff(url, maxAttempts = 6) {
    let attempt = 0;
    let delay = 2000;
    while (attempt < maxAttempts) {
        try {
            const client = new ioredis_1.default(url);
            await client.ping();
            return client;
        }
        catch (error) {
            attempt++;
            if (attempt >= maxAttempts)
                throw error;
            console.log(`Redis connection failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
    throw new Error('Failed to connect to Redis after all attempts');
}
//# sourceMappingURL=redis.js.map