import type { FastifyInstance } from 'fastify';
import { metaClient } from '../db/meta-client';

interface AdminAuthResponse {
  token: string;
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey || !apiKey.startsWith('archive_')) {
    return false;
  }

  const admin = await metaClient.admin.findFirst({
    where: { api_key: apiKey },
  });

  return admin !== null;
}

export async function generateAdminJwt(fastify: FastifyInstance, apiKey: string): Promise<AdminAuthResponse> {
  if (!(await validateApiKey(apiKey))) {
    throw new Error('Invalid API key');
  }

  const admin = await metaClient.admin.findFirst({
    where: { api_key: apiKey },
    select: { id: true, username: true },
  });

  if (!admin) {
    throw new Error('Admin not found');
  }

  const token = (fastify as unknown as { jwt: { sign: (payload: unknown) => string } }).jwt.sign({
    adminId: admin.id,
    username: admin.username,
    role: 'admin',
  });

  return { token };
}
