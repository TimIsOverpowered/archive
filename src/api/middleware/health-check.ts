import { FastifyRequest, FastifyReply } from 'fastify';
import { getHealthToken } from '../../config/env.js';

export default async function healthCheckMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const token = request.headers['x-health-token'];
  const expectedToken = getHealthToken();

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
