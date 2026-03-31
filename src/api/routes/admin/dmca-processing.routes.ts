import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

interface DmcaRequestBody {
  vodId: string;
  claims: any[] | string;
  platform?: 'twitch' | 'kick';
  type?: 'vod' | 'live';
  partIndex?: number; // Optional - if provided, processes only that part (0-indexed from API)
}

export default async function dmcaProcessingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  /**
   * Shared DMCA processing logic - handles both full VOD and specific part processing
   */
  async function processDmcaRequest(streamerId: string, body: DmcaRequestBody, requestLog: any): Promise<any> {
    const config = getStreamerConfig(streamerId);

    if (!config) throw new Error('Tenant not found');

    let client: any;

    try {
      const ClientModule = await import('../../../db/client');
      client = ClientModule.getClient(streamerId);

      if (!client) throw new Error('Database not available');
    } catch (error: any) {
      requestLog.error(`[${streamerId}] Database error in DMCA processing: ${error.message}`);
      throw new Error('Database not available');
    }

    let vodRecord: any;

    try {
      vodRecord = await client.vod.findUnique({ where: { id: body.vodId } });
    } catch {
      vodRecord = null;
    }

    if (!vodRecord) throw new Error('VOD not found');

    // Parse claims from various formats (array or JSON string)
    const claimsArray = Array.isArray(body.claims) ? body.claims : JSON.parse(typeof body.claims === 'string' ? body.claims : JSON.stringify(body.claims));

    // Build job data - only include part field if partIndex is provided
    const dmcaJobData: any = {
      streamerId,
      vodId: String(vodRecord.id),
      receivedClaims: claimsArray,
      type: body.type || 'vod',
      platform: body.platform || (vodRecord.platform as 'twitch' | 'kick'),
    };

    // Only add part field if partIndex is explicitly provided and valid
    if (body.partIndex !== undefined && body.partIndex !== null) {
      dmcaJobData.part = Number(body.partIndex) + 1; // Convert to 1-indexed for worker

      requestLog.info(`[${streamerId}] DMCA processing job queued for ${body.vodId} Part ${Number(body.partIndex) + 1}`);
    } else {
      requestLog.info(`[${streamerId}] DMCA processing job queued for full VOD ${body.vodId}`);
    }

    const DmcaQueueModule = await import('../../../jobs/queues');

    // Queue the DMCA processing job (handles both full and part processing in worker)
    await (DmcaQueueModule.getDmcaProcessingQueue() as any).add(dmcaJobData);

    return {
      data: {
        message: body.partIndex !== undefined ? `DMCA part processing started` : 'DMCA processing started',
        vodId: String(vodRecord.id),
        ...(body.partIndex !== undefined && { part: Number(body.partIndex) + 1 }),
      },
    };
  }

  // Main DMCA endpoint - process claims for full VOD or specific part
  fastify.post(
    '/:id/dmca',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: 'Process DMCA claims for a VOD (or specific part if provided) - mutes audio or applies blackout, then queues YouTube upload',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            claims: {}, // Accept any format - array or JSON string
            partIndex: { type: 'number' }, // Optional - if provided, processes only that part (0-indexed)
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            type: { type: 'string', enum: ['vod', 'live'] },
          },
          required: ['vodId', 'claims'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request: any) => {
      const streamerId = request.params.id;

      try {
        return await processDmcaRequest(streamerId, request.body as DmcaRequestBody, request.log);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] DMCA processing failed: ${errorMsg}`);

        throw new Error('Failed to queue DMCA processing job');
      }
    }
  );

  // Legacy endpoint - kept for backward compatibility, uses same logic as /dmca
  fastify.post(
    '/:id/part-dmca',
    {
      schema: {
        tags: ['Admin', 'Tenants'],
        description: '[DEPRECATED] Use /dmca with partIndex parameter instead. Process DMCA claim for specific part of VOD.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string' },
            claims: {}, // Accept any format - array or JSON string
            partIndex: { type: 'number' }, // Optional - if not provided, processes full VOD like /dmca endpoint
            platform: { type: 'string', enum: ['twitch', 'kick'] },
            type: { type: 'string', enum: ['vod', 'live'] },
          },
          required: ['vodId', 'claims'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware],
    },
    async (request: any) => {
      const streamerId = request.params.id;

      try {
        // Log deprecation warning but continue processing for backward compatibility
        request.log.warn(`[${streamerId}] /part-dmca endpoint is deprecated. Use /dmca with partIndex parameter instead.`);

        return await processDmcaRequest(streamerId, request.body as DmcaRequestBody, request.log);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        request.log.error(`[${streamerId}] DMCA processing failed: ${errorMsg}`);

        throw new Error('Failed to queue DMCA processing job');
      }
    }
  );

  return fastify;
}
