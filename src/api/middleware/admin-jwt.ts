import { FastifyRequest, FastifyReply } from 'fastify';

export default async function adminJwtMiddleware(request: FastifyRequest, reply: FastifyReply) {
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
    (request as unknown as { user: unknown }).user = decoded;
  } catch {
    return reply.status(401).send({
      error: {
        message: 'Invalid or expired token',
        code: 'UNAUTHORIZED',
        statusCode: 401,
      },
    });
  }
}
