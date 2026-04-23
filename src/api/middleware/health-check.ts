import { FastifyRequest, FastifyReply } from 'fastify';
import { getHealthToken } from '../../config/env.js';

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Health check token validation middleware.
 * Requires `x-health-token` header matching the configured token (timing-safe comparison).
 */
export default async function healthCheckMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const rawToken = request.headers['x-health-token'];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  const expectedToken = getHealthToken();

  if (!token || !expectedToken || !timingSafeEqual(token, expectedToken)) {
    return reply.status(401).send({
      statusCode: 401,
      message: 'Invalid health check token',
      code: 'UNAUTHORIZED',
    });
  }
}
