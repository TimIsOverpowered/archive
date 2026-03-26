"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metaClient = void 0;
const meta_1 = require("../../prisma/generated/meta");
const globalForPrisma = globalThis;
exports.metaClient = (globalForPrisma.prismaMeta || new meta_1.PrismaClient({ datasources: { db: { url: process.env.META_DATABASE_URL } } }));
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.prismaMeta = exports.metaClient;
//# sourceMappingURL=meta-client.js.map