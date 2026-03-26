"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateApiKey = validateApiKey;
exports.generateAdminJwt = generateAdminJwt;
const meta_client_1 = require("../db/meta-client");
async function validateApiKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('archive_')) {
        return false;
    }
    const admin = await meta_client_1.metaClient.admin.findFirst({
        where: { api_key: apiKey },
    });
    return admin !== null;
}
async function generateAdminJwt(fastify, apiKey) {
    if (!(await validateApiKey(apiKey))) {
        throw new Error('Invalid API key');
    }
    const admin = await meta_client_1.metaClient.admin.findFirst({
        where: { api_key: apiKey },
        select: { id: true, username: true },
    });
    if (!admin) {
        throw new Error('Admin not found');
    }
    const token = fastify.jwt.sign({
        adminId: admin.id,
        username: admin.username,
        role: 'admin',
    });
    return { token };
}
//# sourceMappingURL=admin.service.js.map