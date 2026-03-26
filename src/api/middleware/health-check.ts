import { FastifyRequest, FastifyReply } from 'fastify';

export default async function healthCheckMiddleware(request: FastifyRequest, reply: FastifyReply) {
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
