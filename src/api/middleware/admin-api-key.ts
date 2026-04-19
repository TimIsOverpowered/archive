import { FastifyRequest, FastifyReply } from 'fastify';
import { validateApiKey } from '../../services/admin.service.js';
import { getMetaClient } from '../../db/meta-client.js';

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
  const authHeader = request.headers.authorization || request.headers['Authorization'];
  const apiKeyHeader = request.headers['x-api-key'] || request.headers['X-Api-Key'] || request.headers['X-API-Key'];

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

  const isValid = await validateApiKey(apiKey);

  if (!isValid) {
    return reply.status(403).send({
      error: {
        message: 'Invalid API key',
        code: 'FORBIDDEN',
        statusCode: 403,
      },
    });
  }

  const admin = await getMetaClient().admin.findFirst({
    where: { api_key: apiKey },
    select: { id: true, username: true },
  });

  if (!admin) {
    return reply.status(403).send({
      error: {
        message: 'Admin not found',
        code: 'FORBIDDEN',
        statusCode: 403,
      },
    });
  }

  (request as { admin: AdminContext }).admin = {
    adminId: admin.id,
    username: admin.username,
  };
}
