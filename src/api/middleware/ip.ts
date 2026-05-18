import type { FastifyRequest } from 'fastify';

/** Extract client IP from forwarded headers or socket address. */
export function getClientIp(request: FastifyRequest): string {
  return (
    (request.headers['cf-connecting-ip'] as string) ??
    (request.headers['x-real-ip'] as string) ??
    (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    request.ip ??
    'unknown'
  );
}
