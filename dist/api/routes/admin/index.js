"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = adminRoutes;
const auth_1 = __importDefault(require("./auth"));
const tenants_1 = __importDefault(require("./tenants"));
async function adminRoutes(fastify, _options) {
    await fastify.register(auth_1.default);
    await fastify.register(tenants_1.default);
}
//# sourceMappingURL=index.js.map