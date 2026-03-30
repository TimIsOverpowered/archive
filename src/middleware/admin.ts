import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import { metaClient } from '../db/meta-client.js';
import { logger } from '../utils/logger.js';

interface AdminUser {
  id: number;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AdminUser;
  }
}

export function adminAuth() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = req.headers.authorization;

    // Get client IP with proper priority for Cloudflare + nginx reverse proxy setup
    // Priority order: cf-connecting-ip > x-real-ip > x-forwarded-for[0] > req.ip (fallback)
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    const xRealIp = req.headers['x-real-ip'];
    const forwardedFor = req.headers['x-forwarded-for'];

    let clientIP: string;

    if (typeof cfConnectingIp === 'string' && cfConnectingIp) {
      // Cloudflare provides the real user IP first - use it when available
      clientIP = Array.isArray(cfConnectingIp) ? cfConnectingIp[0].trim() : cfConnectingIp.trim();
    } else if (typeof xRealIp === 'string' && xRealIp) {
      // Nginx reverse proxy header
      clientIP = Array.isArray(xRealIp) ? xRealIp[0].trim() : xRealIp.trim();
    } else if (Array.isArray(forwardedFor)) {
      // Fallback to first entry in X-Forwarded-For chain
      const ffString = forwardedFor.join(',');
      clientIP = ffString.split(',')[0].trim() || '';
    } else if (typeof forwardedFor === 'string') {
      clientIP = forwardedFor.split(',')[0].trim() || '';
    } else {
      // Last resort - use Fastify's computed IP
      clientIP = req.ip?.trim() || '';
    }

    if (!authHeader) {
      logger.warn({ ip: clientIP, path: req.url }, '[AUTH FAIL] Missing Authorization header');
      return reply.status(401).send({
        error: true,
        msg: 'Missing Authorization header',
      });
    }

    if (!authHeader.startsWith('Bearer ')) {
      logger.warn({ ip: clientIP, path: req.url }, '[AUTH FAIL] Invalid header format (must use Bearer scheme)');
      return reply.status(401).send({
        error: true,
        msg: 'Authorization header must use Bearer scheme',
      });
    }

    const apiKey = authHeader.substring(7);

    // Look up admin by API key
    const admin = await metaClient.admin.findUnique({
      where: { api_key: apiKey },
    });

    if (!admin) {
      logger.warn({ ip: clientIP, path: req.url }, '[AUTH FAIL] API key not found');
      return reply.status(401).send({
        error: true,
        msg: 'Invalid API key',
      });
    }

    // Verify hash
    const valid = await bcrypt.compare(apiKey, admin.api_key_hash);

    if (!valid) {
      logger.warn({ ip: clientIP, path: req.url }, '[AUTH FAIL] API key hash mismatch');
      return reply.status(403).send({
        error: true,
        msg: 'Invalid API key',
      });
    }

    // Attach admin info to request
    req.user = {
      id: admin.id,
      username: admin.username,
    };

    logger.info({ ip: clientIP, path: req.url, user: admin.username }, '[AUTH SUCCESS]');
  };
}
