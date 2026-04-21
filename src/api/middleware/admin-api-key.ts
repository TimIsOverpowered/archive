import { FastifyRequest, FastifyReply } from 'fastify';
import { findAdminByApiKey } from '../../services/admin.service.js';

export interface AdminContext {
  adminId: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

export default async function adminApiKeyMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  const apiKeyHeader = request.headers['x-api-key'];

  let apiKey: string | undefined;

  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  } else if (apiKeyHeader) {
    apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined;
  }

  if (!apiKey || !apiKey.startsWith('archive_')) {
    return reply.status(401).send({
      error: {
        message: 'Missing or invalid API key',
        code: 'UNAUTHORIZED',
        statusCode: 401,
      },
    });
  }

  const admin = await findAdminByApiKey(apiKey);

  if (!admin) {
    return reply.status(403).send({
      error: {
        message: 'Admin not found',
        code: 'FORBIDDEN',
        statusCode: 403,
      },
    });
  }

  request.admin = {
    adminId: admin.id,
    username: admin.username,
  };
}
