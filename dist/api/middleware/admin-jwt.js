"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = adminJwtMiddleware;
async function adminJwtMiddleware(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({
            error: {
                message: 'Missing or invalid authorization header',
                code: 'UNAUTHORIZED',
                statusCode: 401,
            },
        });
    }
    const token = authHeader.substring(7);
    try {
        const decoded = request.jwt.verify(token);
        request.user = decoded;
    }
    catch {
        return reply.status(401).send({
            error: {
                message: 'Invalid or expired token',
                code: 'UNAUTHORIZED',
                statusCode: 401,
            },
        });
    }
}
//# sourceMappingURL=admin-jwt.js.map