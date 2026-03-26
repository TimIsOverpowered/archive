"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAuth = adminAuth;
const bcrypt_1 = __importDefault(require("bcrypt"));
const meta_client_1 = require("../db/meta-client");
function adminAuth() {
    return async (req, reply) => {
        const authHeader = req.headers.authorization;
        const forwardedFor = req.headers['x-forwarded-for'];
        const clientIP = req.ip ||
            req.headers['cf-connecting-ip'] ||
            req.headers['x-real-ip'] ||
            (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0] : undefined) ||
            '';
        if (!authHeader) {
            console.warn(`[AUTH FAIL] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${req.url} | Reason: Missing Authorization header`);
            return reply.status(401).send({
                error: true,
                msg: 'Missing Authorization header',
            });
        }
        if (!authHeader.startsWith('Bearer ')) {
            console.warn(`[AUTH FAIL] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${req.url} | Reason: Invalid header format (must use Bearer scheme)`);
            return reply.status(401).send({
                error: true,
                msg: 'Authorization header must use Bearer scheme',
            });
        }
        const apiKey = authHeader.substring(7);
        // Look up admin by API key
        const admin = await meta_client_1.metaClient.admin.findUnique({
            where: { api_key: apiKey },
        });
        if (!admin) {
            console.warn(`[AUTH FAIL] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${req.url} | Reason: API key not found`);
            return reply.status(401).send({
                error: true,
                msg: 'Invalid API key',
            });
        }
        // Verify hash
        const valid = await bcrypt_1.default.compare(apiKey, admin.api_key_hash);
        if (!valid) {
            console.warn(`[AUTH FAIL] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${req.url} | Reason: API key hash mismatch`);
            return reply.status(403).send({
                error: true,
                msg: 'Invalid API key',
            });
        }
        // Attach admin info to request
        req.user = {
            id: admin.id,
            username: admin.username,
        };
        console.info(`[AUTH SUCCESS] ${new Date().toISOString()} | IP: ${clientIP} | Path: ${req.url} | User: ${admin.username}`);
    };
}
//# sourceMappingURL=admin.js.map