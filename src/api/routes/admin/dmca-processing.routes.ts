import type { DmcaProcessingJob } from '../../../types/queues.js';
import { enqueueJobWithLogging } from '../../../jobs/queues.js';

import { FastifyInstance } from 'fastify';
import { getTenantConfig } from '../../../config/loader';
import { getClient } from '../../../db/client.js';
import createRateLimitMiddleware from '../../middleware/rate-limit';
import adminApiKeyMiddleware from '../../middleware/admin-api-key';
import { tenantMiddleware, platformValidationMiddleware, type TenantPlatformContext } from '../../middleware/tenant-platform';
import { adminRateLimiter } from '../../plugins/redis.plugin';
import { createAutoLogger } from '../../../utils/auto-tenant-logger.js';
import { notFound } from '../../../utils/http-error';

type VodRecord = { id: number; platform: 'twitch' | 'kick' };

interface DmcaClaim {
  type?: string;
  reason?: string;
  url?: string;
  [key: string]: unknown;
}

type StrictDmcaClaims = Array<{
  type: 'CLAIM_TYPE_AUDIO' | 'CLAIM_TYPE_VISUAL' | 'CLAIM_TYPE_AUDIOVISUAL';
  claimPolicy: { primaryPolicy: { policyType: string } };
  matchDetails: { longestMatchStartTimeSeconds: number; longestMatchDurationSeconds: string };
}>;

interface DmcaRequestBody {
  vodId: string;
  claims: DmcaClaim[] | string;
  platform: 'twitch' | 'kick';
  type?: 'vod' | 'live';
  partIndex?: number;
}

interface ProcessDmcaResponse {
  data: { message: string; vodId: number; part?: number };
}

export default async function dmcaProcessingRoutes(fastify: FastifyInstance, _options: Record<string, unknown>) {
  if (!adminRateLimiter) {
    throw new Error('Rate limiter not initialized');
  }

  const rateLimitMiddleware = createRateLimitMiddleware({ limiter: adminRateLimiter });

  /**
   * Shared DMCA processing logic - handles both full VOD and specific part processing
   */
  async function processDmcaRequest(
    config: NonNullable<ReturnType<typeof getTenantConfig>>,
    client: NonNullable<ReturnType<typeof getClient>>,
    tenantId: string,
    body: DmcaRequestBody,
    log: ReturnType<typeof createAutoLogger>
  ): Promise<ProcessDmcaResponse> {
    let vodRecord: VodRecord | null = null;

    try {
      const dbResult = await client.vod.findUnique({ where: { platform_vod_id: { vod_id: String(body.vodId), platform: body.platform } } });
      if (dbResult) {
        vodRecord = dbResult as VodRecord;
      }
    } catch {
      // VOD not found or error looking up
    }

    if (!vodRecord) notFound('VOD not found');

    // Parse claims from various formats (array or JSON string)
    const claimsArray: DmcaClaim[] = Array.isArray(body.claims) ? body.claims : JSON.parse(typeof body.claims === 'string' ? body.claims : JSON.stringify(body.claims));

    // Cast at boundary to match strict queue type definition
    const dmcaJobData: Omit<DmcaProcessingJob, 'receivedClaims'> & { receivedClaims: StrictDmcaClaims } = {
      tenantId,
      vodId: String(vodRecord.id),
      receivedClaims: claimsArray as StrictDmcaClaims,
      type: body.type || 'vod',
      platform: body.platform,
    };

    // Only add part field if partIndex is explicitly provided and valid
    if (body.partIndex !== undefined && body.partIndex !== null) {
      dmcaJobData.part = Number(body.partIndex) + 1; // Convert to 1-indexed for worker

      log.info(`DMCA processing job queued for ${body.vodId} Part ${Number(body.partIndex) + 1}`);
    } else {
      log.info(`DMCA processing job queued for full VOD ${body.vodId}`);
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
      { info: log.info.bind(log), debug: log.debug.bind(log) },
      'DMCA processing job queued',
      { vodId: body.vodId, part: body.partIndex !== undefined ? Number(body.partIndex) + 1 : undefined }
    );

    if (isNew) {
      log.debug({ vodId: body.vodId, jobId: actualJobId }, 'Job was newly added to queue');
    }

    return {
      data: {
        message: body.partIndex !== undefined ? `DMCA part processing started` : 'DMCA processing started',
        vodId: vodRecord.id,
        ...(body.partIndex !== undefined && { part: Number(body.partIndex) + 1 }),
      },
    };
  }

  // Main DMCA endpoint - process claims for full VOD or specific part
  fastify.post<{ Body: DmcaRequestBody; Params: { tenantId: string } }>(
    '/dmca',
    {
      schema: {
        tags: ['Admin'],
        description: 'Process DMCA claims for a VOD (or specific part if provided) - mutes audio or applies blackout, then queues YouTube upload',
        params: { type: 'object', properties: { tenantId: { type: 'string', description: 'Tenant ID' } }, required: ['tenantId'] },
        body: {
          type: 'object',
          properties: {
            vodId: { type: 'string', description: 'Platform VOD ID' },
            claims: {},
            partIndex: { type: 'number' },
            platform: { type: 'string', enum: ['twitch', 'kick'], description: 'Source platform' },
            type: { type: 'string', enum: ['vod', 'live'] },
          },
          required: ['vodId', 'claims', 'platform'],
        },
        security: [{ apiKey: [] }],
      },
      onRequest: [adminApiKeyMiddleware, rateLimitMiddleware, tenantMiddleware],
      preValidation: [platformValidationMiddleware],
    },
    async (request) => {
      const { tenantId, config, client, platform } = request.tenant as TenantPlatformContext;
      const log = createAutoLogger(tenantId);

      return await processDmcaRequest(config!, client, tenantId, { ...request.body, platform }, log);
    }
  );

  return fastify;
}
