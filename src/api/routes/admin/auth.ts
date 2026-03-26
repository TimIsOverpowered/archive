import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { generateAdminJwt } from '../../../services/admin.service';
import createRateLimitMiddleware from '../../middleware/rate-limit';

type AuthRoutesOptions = Record<string, unknown>;

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

export default async function authRoutes(fastify: FastifyInstance, _options: AuthRoutesOptions) {
  const rateLimitMiddleware = createRateLimitMiddleware({
    limiter: fastify.adminRateLimiter,
  });

  fastify.post(
    '/key',
    {
      schema: {
        tags: ['Admin', 'Auth'],
        description: 'Exchange API key for JWT token',
        headers: {
          type: 'object',
          properties: {
            'x-api-key': {
              type: 'string',
              description: 'Admin API key (must start with archive_)',
              pattern: '^archive_[0-9a-f]{64}$',
            },
          },
          required: ['x-api-key'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                },
              },
            },
          },
        },
      },
      onRequest: rateLimitMiddleware,
    },
    async (request) => {
      const apiKey = request.headers['x-api-key'] as string | undefined;

      if (!apiKey || !apiKey.startsWith('archive_')) {
        throw new Error('Invalid API key format');
      }

      try {
        const { token } = await generateAdminJwt(fastify, apiKey);
        return { data: { token } };
      } catch (error) {
        throw error;
      }
    }
  );
}
