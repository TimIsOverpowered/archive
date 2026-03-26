"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnvironment = validateEnvironment;
const encryption_1 = require("../utils/encryption");
function validateEnvironment() {
    if (!process.env.META_DATABASE_URL)
        throw new Error('META_DATABASE_URL is required');
    if (!(0, encryption_1.validateEncryptionKey)(process.env.ENCRYPTION_MASTER_KEY || '')) {
        throw new Error('ENCRYPTION_MASTER_KEY must be set and exactly 32 characters (64 hex chars for AES-256)');
    }
    if (!process.env.JWT_SECRET)
        throw new Error('JWT_SECRET is required');
    if (!process.env.REDIS_URL) {
        console.warn('REDIS_URL not set - queues will fail to connect');
    }
}
//# sourceMappingURL=validator.js.map