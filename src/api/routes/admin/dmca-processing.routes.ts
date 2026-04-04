import type { DmcaProcessingJob } from '../../../jobs/queues.js';
import { enqueueJobWithLogging } from '../../../jobs/queues.js';
import { extractErrorDetails } from '../../../utils/error.js';
import { FastifyInstance } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getStreamerConfig } from '../../../config/loader';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { getClient } from '../../../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    adminRateLimiter: RateLimiterRedis;
  }
}

type VodRecord = { id: string; platform: 'twitch' | 'kick' };

type StreamerDbClient = ReturnType<typeof getClient>;

interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

// Cast to match the strict queue definition - incoming API data is loose but we cast at boundary
type StrictDmcaClaims = Array<{
  type: 'CLAIM_TYPE_AUDIO' | 'CLAIM_TYPE_VISUAL' | 'CLAIM_TYPE_AUDIOVISUAL';
  claimPolicy: { primaryPolicy: { policyType: string } };
  matchDetails: { longestMatchStartTimeSeconds: number; longestMatchDurationSeconds: string };
}>;

interface DmcaRequestBody {
  vodId: string;
  claims: DmcaClaim[] | string;
  platform?: 'twitch' | 'kick';
  type?: 'vod' | 'live';
  partIndex?: number; // Optional - if provided, processes only that part (0-indexed from API)
}

interface ProcessDmcaResponse {
  data: { message: string; vodId: string; part?: number };
}

export default async function dmcaProcessingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: fastify.adminRateLimiter });

  /**
   * Shared DMCA processing logic - handles both full VOD and specific part processing
   */
  async function processDmcaRequest(streamerId: string, body: DmcaRequestBody, requestLog: FastifyInstance['log']): Promise<ProcessDmcaResponse> {
    const config = getStreamerConfig(streamerId);

    if (!config) throw new Error('Tenant not found');

    let client: StreamerDbClient | null = null;

    client = getClient(streamerId);

    if (!client) {
      requestLog.error(`[${streamerId}] Database error in DMCA processing`);
      throw new Error('Database not available');
    }

    let vodRecord: VodRecord | null = null;

    try {
      const dbResult = await client.vod.findUnique({ where: { id: body.vodId } });
      if (dbResult) {
        vodRecord = dbResult as VodRecord;
      }
    } catch {
      // VOD not found or error looking up
    }

    if (!vodRecord) throw new Error('VOD not found');

    // Parse claims from various formats (array or JSON string)
    const claimsArray: DmcaClaim[] = Array.isArray(body.claims) ? body.claims : JSON.parse(typeof body.claims === 'string' ? body.claims : JSON.stringify(body.claims));

    // Cast at boundary to match strict queue type definition
    const dmcaJobData: Omit<DmcaProcessingJob, 'receivedClaims'> & { receivedClaims: StrictDmcaClaims } = {
      streamerId,
      vodId: String(vodRecord.id),
      receivedClaims: claimsArray as StrictDmcaClaims,
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
    const jobId = body.partIndex !== undefined ? `dmca_${body.vodId}_p${body.partIndex}` : `dmca_${body.vodId}`;
    const { jobId: actualJobId, isNew } = await enqueueJobWithLogging(
      DmcaQueueModule.getDmcaProcessingQueue(),
      'dmca_processing',
      dmcaJobData,
      {
        jobId,
        deduplication: { id: jobId },
      },
      { info: requestLog.info.bind(requestLog), debug: requestLog.debug.bind(requestLog) },
      `[${streamerId}] DMCA processing job queued`,
      { vodId: body.vodId, part: body.partIndex !== undefined ? Number(body.partIndex) + 1 : undefined }
    );

    if (isNew) {
      requestLog.debug({ vodId: body.vodId, jobId: actualJobId }, `[${streamerId}] Job was newly added to queue`);
    }

    return {
      data: {
        message: body.partIndex !== undefined ? `DMCA part processing started` : 'DMCA processing started',
        vodId: String(vodRecord.id),
        ...(body.partIndex !== undefined && { part: Number(body.partIndex) + 1 }),
      },
    };
  }

  // Main DMCA endpoint - process claims for full VOD or specific part
  fastify.post<{ Body: DmcaRequestBody; Params: { id: string } }>(
    '/:id/dmca',
    {
      schema: {
        tags: ['Admin'],
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
    async (request) => {
      const streamerId = request.params.id;

      try {
        return await processDmcaRequest(streamerId, request.body, request.log);
      } catch (error) {
        const details = extractErrorDetails(error);
        const errorMsg = details.message;
        request.log.error(`[${streamerId}] DMCA processing failed: ${errorMsg}`);

        throw new Error('Failed to queue DMCA processing job');
      }
    }
  );

  return fastify;
}
