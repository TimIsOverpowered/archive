"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = healthCheckMiddleware;
async function healthCheckMiddleware(request, reply) {
    const token = request.headers['x-health-token'];
    const expectedToken = process.env.HEALTH_TOKEN;
    if (!token || !expectedToken || token !== expectedToken) {
        return reply.status(401).send({
            error: {
                message: 'Invalid health check token',
                code: 'UNAUTHORIZED',
                statusCode: 401,
            },
        });
    }
}
//# sourceMappingURL=health-check.js.map